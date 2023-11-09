use {
    ethers::signers,
    hapi_core::HapiCoreNetwork,
    hapi_indexer::IndexingCursor,
    mockito::{Matcher, Server, ServerGuard},
    serde_json::{json, Value},
    std::fmt::LowerHex,
};

use ethers::{
    abi::{Abi, Event},
    signers::{Signer, Wallet},
    types::{Block, BlockNumber},
};
use ethers::{types::BlockId, utils::keccak256};
use rand::RngCore;
use std::fs;

use std::{collections::HashMap, str::FromStr, sync::Arc};

use enum_extract::let_extract;
use ethers::{
    abi::{Token, Tokenizable},
    prelude::{abigen, SignerMiddleware},
    providers::{Http, Middleware, Provider},
    signers::LocalWallet,
    types::{Address, Bytes, Filter, Log, H256, U256},
};
use hapi_core::client::events::EventName;
use hapi_indexer::PushData;
use solana_sdk::signature::Signature;

use super::{RpcMock, TestBatch, PAGE_SIZE};

pub const CONTRACT_ADDRESS: &str = "0x2947F98C42597966a0ec25e92843c09ac18Fbab7";
pub const ABI: &str = "../evm/artifacts/contracts/HapiCore.sol/HapiCore.json";

abigen!(
    HAPI_CORE_CONTRACT,
    "../evm/artifacts/contracts/HapiCore.sol/HapiCore.json"
);

pub struct EvmMock {
    server: ServerGuard,
    contract: HAPI_CORE_CONTRACT<SignerMiddleware<Provider<Http>, LocalWallet>>,
}

impl RpcMock for EvmMock {
    fn get_contract_address() -> String {
        CONTRACT_ADDRESS.to_string()
    }

    fn get_network() -> HapiCoreNetwork {
        HapiCoreNetwork::Ethereum
    }

    fn get_hashes() -> [String; 17] {
        let signatures: [String; 17] = (0..17)
            .map(|_| generate_hash())
            .collect::<Vec<_>>()
            .try_into()
            .expect("Failed to create signatures");

        signatures
    }

    fn generate_address() -> String {
        hex::encode(
            LocalWallet::new(&mut rand::thread_rng())
                .address()
                .as_bytes(),
        )
    }

    fn initialize() -> Self {
        let server = Server::new();

        let provider =
            Provider::<Http>::try_from(server.url()).expect("Provider intialization failed");
        let wallet = LocalWallet::new(&mut rand::thread_rng());
        let client = SignerMiddleware::new(provider, wallet);

        let contract = HAPI_CORE_CONTRACT::new(
            CONTRACT_ADDRESS
                .parse::<Address>()
                .expect("Failed to parse address"),
            Arc::new(client),
        );

        Self { server, contract }
    }

    fn get_mock_url(&self) -> String {
        self.server.url()
    }

    fn get_cursor(batch: &[TestBatch]) -> IndexingCursor {
        batch
            .first()
            .map(|batch| batch.first().expect("Empty batch"))
            .map(|data| IndexingCursor::Block(data.block))
            .unwrap_or(IndexingCursor::None)
    }

    fn fetching_jobs_mock(&mut self, batches: &[TestBatch], cursor: &IndexingCursor) {
        let mut to_block = 0;
        let mut from_block = match &cursor {
            IndexingCursor::None => 0,
            IndexingCursor::Block(block) => *block,
            _ => panic!("Evm network must have a block cursor"),
        };

        for batch in batches {
            to_block = from_block + PAGE_SIZE;
            let logs = Self::get_logs(batch);

            let response = json!({
               "jsonrpc": "2.0",
               "result": logs,
               "id": 1
            });

            let params = Filter::default()
                .address(
                    CONTRACT_ADDRESS
                        .parse::<Address>()
                        .expect("Failed to parse address"),
                )
                .from_block(from_block)
                .to_block(to_block);

            self.server
                .mock("POST", "/")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(&response.to_string())
                .match_body(Matcher::PartialJson(json!({
                    "method": "eth_getLogs",
                    "params": [ params ]
                })))
                .create();

            from_block = to_block;
        }

        self.latest_block_mock(to_block);
    }

    fn processing_jobs_mock(&mut self, batch: &TestBatch) {
        for event in batch {
            self.block_request_mock(event.block);

            if let Some(data) = &event.data {
                self.processing_data_mock(data, event.block);
            }
        }
    }
}

impl EvmMock {
    fn latest_block_mock(&mut self, number: u64) {
        let response = json!({
           "jsonrpc": "2.0",
           "result": format!("{number:#x}"),
           "id": 1
        });

        self.server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(&response.to_string())
            .match_body(Matcher::PartialJson(json!({
                "method":"eth_blockNumber",
            })))
            .create();
    }

    fn get_logs(batch: &TestBatch) -> Vec<Log> {
        let mut res = vec![];
        let address = CONTRACT_ADDRESS
            .parse::<Address>()
            .expect("Failed to parse address");

        // TODO: fetch from abi
        let event_signatures = Self::get_events_signatures();

        for event in batch {
            let signature = event_signatures
                .get(&event.name.to_string())
                .expect("Failed to get event signature");

            let mut log = Log {
                address: address.clone(),
                topics: vec![signature.clone()],
                data: Bytes::new(),
                block_hash: Some(H256::from_low_u64_be(event.block.into())),
                block_number: Some(event.block.into()),
                transaction_hash: Some(
                    H256::from_str(&event.hash).expect("Failed to parse transaction hash"),
                ),
                transaction_index: None,
                log_index: None,
                transaction_log_index: None,
                log_type: None,
                removed: None,
            };

            match event.name {
                EventName::Initialize => {
                    let version_token = Token::Uint(U256::from(1));

                    log.data = ethers::abi::encode(&[version_token]).into();
                }
                EventName::SetAuthority => {
                    let address = Self::generate_address()
                        .parse::<Address>()
                        .expect("Invalid address");

                    log.data = ethers::abi::encode(&[Token::Address(address)]).into();
                }
                EventName::UpdateStakeConfiguration => {
                    let token = Self::generate_address()
                        .parse::<Address>()
                        .expect("Invalid address");
                    let unlock_duration: U256 = 100.into();
                    let validator_stake: U256 = 100.into();
                    let tracer_stake: U256 = 100.into();
                    let publisher_stake: U256 = 100.into();
                    let authority_stake: U256 = 100.into();

                    log.data = ethers::abi::encode(&[
                        Token::Address(token),
                        Token::Uint(unlock_duration),
                        Token::Uint(validator_stake),
                        Token::Uint(tracer_stake),
                        Token::Uint(publisher_stake),
                        Token::Uint(authority_stake),
                    ])
                    .into();
                }
                EventName::UpdateRewardConfiguration => {
                    let token = Self::generate_address()
                        .parse::<Address>()
                        .expect("Invalid address");
                    let address_confirmation_reward: U256 = 100.into();
                    let address_tracer_reward: U256 = 100.into();
                    let asset_confirmation_reward: U256 = 100.into();
                    let asset_tracer_reward: U256 = 100.into();

                    log.data = ethers::abi::encode(&[
                        Token::Address(token),
                        Token::Uint(address_confirmation_reward),
                        Token::Uint(address_tracer_reward),
                        Token::Uint(asset_confirmation_reward),
                        Token::Uint(asset_tracer_reward),
                    ])
                    .into();
                }
                EventName::CreateReporter
                | EventName::UpdateReporter
                | EventName::ActivateReporter
                | EventName::DeactivateReporter
                | EventName::Unstake => {
                    let_extract!(
                        PushData::Reporter(data),
                        event.data.as_ref().expect("Empty data"),
                        panic!("Wrong message encoding")
                    );

                    let id_topic = u128_to_bytes(data.id.as_u128()).into();
                    let reporter: Address = data.account.parse().expect("Invalid address");
                    let role = data.role.clone() as u8;

                    log.topics.append(&mut vec![id_topic]);
                    log.data = ethers::abi::encode(&[
                        Token::Address(reporter),
                        Token::Uint(U256::from(role)),
                    ])
                    .into();
                }
                EventName::CreateCase | EventName::UpdateCase => {
                    // TODO: case update - status closed
                }
                EventName::CreateAddress | EventName::UpdateAddress | EventName::ConfirmAddress => {
                    let_extract!(
                        PushData::Address(data),
                        event.data.as_ref().expect("Empty data"),
                        panic!("Wrong message encoding")
                    );

                    let addr: Address = data.address.parse().expect("Invalid address");
                    let risk = data.risk;
                    let category = data.category.clone() as u8;
                    let addr_topic = H256::from(addr);

                    log.topics.append(&mut vec![addr_topic]);
                    log.data = ethers::abi::encode(&[
                        Token::Uint(U256::from(risk)),
                        Token::Uint(U256::from(category)),
                    ])
                    .into();
                }
                EventName::CreateAsset | EventName::UpdateAsset | EventName::ConfirmAsset => {
                    let_extract!(
                        PushData::Asset(data),
                        event.data.as_ref().expect("Empty data"),
                        panic!("Wrong message encoding")
                    );

                    let addr: Address = data.address.parse().expect("Invalid address");
                    let asset_id: U256 = data.asset_id.clone().into();
                    let risk = data.risk;
                    let category = data.category.clone() as u8;
                    let addr_topic = H256::from(addr);

                    log.topics.append(&mut vec![addr_topic]);
                    log.data = ethers::abi::encode(&[
                        Token::Uint(asset_id),
                        Token::Uint(U256::from(risk)),
                        Token::Uint(U256::from(category)),
                    ])
                    .into();
                }
            }

            res.push(log);
        }

        res
    }

    fn get_events_signatures() -> HashMap<String, H256> {
        let parsed_json: Value =
            serde_json::from_str(&fs::read_to_string(ABI).expect("Failed to read ABI file"))
                .expect("Failed to psarse ABI JSON");

        let abi_entries = parsed_json["abi"]
            .as_array()
            .expect("Failed to find 'abi' key in JSON");

        // Parse the actual ABI.
        let abi: Abi = serde_json::from_value(Value::Array(abi_entries.clone()))
            .expect("Failed to parse ABI JSON");

        let mut signatures = HashMap::new();

        // Extract the event signatures.
        for event in abi.events() {
            let signature = get_signature(&event);
            let topic_hash: H256 = keccak256(signature.as_bytes()).into();

            // println!(
            //     "Event name: {}, Signature Topic: 0x{}",
            //     event.name,
            //     topic_hash.to_string()
            // );

            let_extract!(Ok(event_name), EventName::from_str(&event.name), continue);

            signatures.insert(event_name.to_string(), topic_hash);
        }

        signatures
    }

    fn block_request_mock(&mut self, num: u64) {
        let mut block: Block<H256> = Block::default();
        block.timestamp = 123.into();

        let response = json!({
           "jsonrpc": "2.0",
           "result": block,
           "id": 1
        });

        self.server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(&response.to_string())
            .match_body(Matcher::PartialJson(json!({
                "method": "eth_getBlockByNumber",
                "params": [ format!("{num:#x}"), false ]
            })))
            .create();
    }

    fn processing_data_mock(&mut self, data: &PushData, block_id: u64) {
        let (raw_tx, result) = match data {
            PushData::Address(address) => {
                let addr = address
                    .address
                    .parse::<Address>()
                    .expect("Failed to parse address");

                let case_id = U256::from_big_endian(&u128_to_bytes(address.case_id.as_u128()));
                let reporter_id =
                    U256::from_big_endian(&u128_to_bytes(address.reporter_id.as_u128()));
                let confirmation = U256::zero();
                let risk = U256::from(address.risk);
                let category = U256::from(address.category.clone() as u8);

                let raw_tx = self.contract.get_address(addr).tx;
                let responce = hex::encode(ethers::abi::encode(&[
                    Token::Address(addr),
                    Token::Uint(case_id),
                    Token::Uint(reporter_id),
                    Token::Uint(confirmation),
                    Token::Uint(risk),
                    Token::Uint(category),
                ]));

                (raw_tx, responce)
            }
            PushData::Asset(asset) => {
                let address = asset.address.parse().expect("Failed to parse address");
                let raw_tx = self
                    .contract
                    .get_asset(address, asset.asset_id.clone().into())
                    .tx;

                (raw_tx, "".to_string())
            }
            PushData::Case(case) => {
                let raw_tx = self.contract.get_case(case.id.as_u128()).tx;

                (raw_tx, "".to_string())
            }
            PushData::Reporter(reporter) => {
                let raw_tx = self.contract.get_reporter(reporter.id.as_u128()).tx;

                (raw_tx, "".to_string())
            }
        };

        let tx = serde_json::to_value(raw_tx).expect("Failed to serialize raw transaction");
        let block = serde_json::to_value(BlockId::Number(BlockNumber::Number(block_id.into())))
            .expect("Failed to serialize block id");

        let response = json!({
           "jsonrpc": "2.0",
           "result": result ,
           "id": 1
        });

        self.server
            .mock("POST", "/")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(&response.to_string())
            .match_body(Matcher::PartialJson(json!({
                "method": "eth_call",
                "params": [ tx, block ]
            })))
            .create();
    }
}

fn u128_to_bytes(value: u128) -> [u8; 32] {
    let mut buffer = [0u8; 32];
    buffer[16..].copy_from_slice(&value.to_be_bytes());

    buffer
}

fn generate_hash() -> String {
    let mut rng = rand::thread_rng();
    let mut data = [0u8; 32];
    rng.fill_bytes(&mut data);

    hex::encode(keccak256(data).to_vec())
}

fn get_signature(event: &Event) -> String {
    let inputs = event
        .inputs
        .iter()
        .map(|param| param.kind.to_string())
        .collect::<Vec<String>>()
        .join(",");

    format!("{}({})", event.name, inputs)
}
