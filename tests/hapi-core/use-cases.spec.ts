import * as anchor from "@project-serum/anchor";
import { web3, BN } from "@project-serum/anchor";

import { TestToken, u64 } from "../util/token";
import { expectThrowError } from "../util/console";
import { pubkeyFromHex } from "../util/crypto";
import {
  CaseStatus,
  Category,
  program,
  ReporterRole,
  bufferFromString,
  ReporterStatus,
} from "../../lib";

describe("HapiCore Use Cases", () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const authority = provider.wallet;

  const nobody = web3.Keypair.generate();

  const REPORTERS: Record<
    string,
    { name: string; keypair: web3.Keypair; type: keyof typeof ReporterRole }
  > = {
    alice: { name: "alice", keypair: web3.Keypair.generate(), type: "Full" },
    bob: { name: "bob", keypair: web3.Keypair.generate(), type: "Tracer" },
    carol: {
      name: "carol",
      keypair: web3.Keypair.generate(),
      type: "Validator",
    },
  };

  const NETWORKS: Record<string, { name: string }> = {
    ethereum: { name: "ethereum" },
    solana: { name: "solana" },
    near: { name: "near" },
  };

  const CASES: Record<
    string,
    {
      network: keyof typeof NETWORKS;
      caseId: BN;
      name: string;
      reporter: keyof typeof REPORTERS;
    }
  > = {
    safe: {
      network: "ethereum",
      caseId: new BN(1),
      name: "safe network addresses",
      reporter: "alice",
    },
    nftTracking: {
      network: "ethereum",
      caseId: new BN(2),
      name: "suspicious nft txes",
      reporter: "alice",
    },
  };

  const ADDRESSES: Record<
    string,
    {
      pubkey: web3.PublicKey;
      network: keyof typeof NETWORKS;
      category: keyof typeof Category;
      reporter: keyof typeof REPORTERS;
      caseId: BN;
      risk: number;
    }
  > = {
    blackhole: {
      pubkey: pubkeyFromHex(
        "0000000000000000000000000000000000000000000000000000000000000001"
      ),
      network: "ethereum",
      category: "None",
      reporter: "alice",
      caseId: new BN(1),
      risk: 0,
    },
    nftMerchant: {
      pubkey: pubkeyFromHex(
        "6923f8792e9b41a2cc735d4c995b20c8d717cfda8d30e216fe1857389da71c94"
      ),
      network: "ethereum",
      reporter: "bob",
      category: "MerchantService",
      caseId: new BN(2),
      risk: 2,
    },
  };

  const ASSETS: Record<
    string,
    {
      mint: web3.PublicKey;
      assetId: Buffer;
      category: keyof typeof Category;
      reporter: keyof typeof REPORTERS;
      network: keyof typeof NETWORKS;
      caseId: BN;
      risk: number;
    }
  > = {
    stolenNft: {
      mint: pubkeyFromHex(
        "2873d85250e84e093c3f38c78e74c060c834db3cdaa4c09b4ed6aea9718959a8"
      ),
      assetId: Buffer.from(
        "0000000000000000000000000000000000000000000000000000000000000001",
        "hex"
      ),
      network: "ethereum",
      caseId: new BN(2),
      category: "Theft",
      reporter: "bob",
      risk: 4,
    },
  };

  let community: web3.Keypair;
  let stakeToken: TestToken;

  beforeAll(async () => {
    const tx = new web3.Transaction();

    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: nobody.publicKey,
        lamports: 10_000_000,
      }),
      web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: REPORTERS.alice.keypair.publicKey,
        lamports: 10_000_000,
      }),
      web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: REPORTERS.bob.keypair.publicKey,
        lamports: 10_000_000,
      }),
      web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: REPORTERS.carol.keypair.publicKey,
        lamports: 10_000_000,
      })
    );

    await provider.send(tx);

    stakeToken = new TestToken(provider);
    await stakeToken.mint(new u64(1_000_000_000));

    for (const reporter of Object.keys(REPORTERS)) {
      const pubkey = REPORTERS[reporter].keypair.publicKey;

      await stakeToken.transfer(null, pubkey, new u64(1_000_000));
    }
  });

  it("Community is initialized", async () => {
    community = web3.Keypair.generate();

    const validatorStake = new u64(1_000);
    const tracerStake = new u64(2_000);
    const fullStake = new u64(3_000);
    const authorityStake = new u64(4_000);

    const tokenAccount = await stakeToken.createAccount();

    const tx = await program.rpc.initializeCommunity(
      new u64(4),
      3,
      validatorStake,
      tracerStake,
      fullStake,
      authorityStake,
      {
        accounts: {
          authority: authority.publicKey,
          community: community.publicKey,
          stakeMint: stakeToken.mintAccount,
          tokenAccount,
          tokenProgram: stakeToken.programId,
          systemProgram: web3.SystemProgram.programId,
        },
        signers: [community],
      }
    );

    expect(tx).toBeTruthy();
  });

  it.each(Object.keys(NETWORKS))("Network '%s' is created", async (rawName) => {
    const network = NETWORKS[rawName];

    const name = bufferFromString(network.name, 32);

    const [networkAccount, bump] = await program.findNetworkAddress(
      community.publicKey,
      network.name
    );

    const args = [name.toJSON().data, new u64(10_000), new u64(10_000), bump];

    const tx = await program.rpc.createNetwork(...args, {
      accounts: {
        authority: authority.publicKey,
        community: community.publicKey,
        network: networkAccount,
        systemProgram: web3.SystemProgram.programId,
      },
    });

    expect(tx).toBeTruthy();
  });

  it.each(Object.keys(REPORTERS))("Reporter %s is created", async (key) => {
    const reporter = REPORTERS[key];

    const name = bufferFromString(reporter.name, 32);

    const [reporterAccount, bump] = await program.findReporterAddress(
      community.publicKey,
      reporter.keypair.publicKey
    );

    const reporterRole = ReporterRole[reporter.type];

    const tx = await program.rpc.createReporter(
      reporterRole,
      name.toJSON().data,
      bump,
      {
        accounts: {
          authority: authority.publicKey,
          community: community.publicKey,
          reporter: reporterAccount,
          pubkey: reporter.keypair.publicKey,
          systemProgram: web3.SystemProgram.programId,
        },
      }
    );

    expect(tx).toBeTruthy();
  });

  it.each(Object.keys(ADDRESSES))(
    "Inactive reporter can't create address '%s'",
    async (key: keyof typeof ADDRESSES) => {
      const addr = ADDRESSES[key];

      const reporter = REPORTERS[addr.reporter].keypair;

      const [networkAccount] = await program.findNetworkAddress(
        community.publicKey,
        addr.network
      );

      const [addressAccount, bump] = await program.findAddressAddress(
        networkAccount,
        addr.pubkey
      );

      const [reporterAccount] = await program.findReporterAddress(
        community.publicKey,
        reporter.publicKey
      );

      const [caseAccount] = await program.findCaseAddress(
        community.publicKey,
        addr.caseId
      );

      await expectThrowError(
        () =>
          program.rpc.createAddress(
            addr.pubkey,
            Category[addr.category],
            addr.risk,
            bump,
            {
              accounts: {
                sender: reporter.publicKey,
                address: addressAccount,
                community: community.publicKey,
                network: networkAccount,
                reporter: reporterAccount,
                case: caseAccount,
                systemProgram: web3.SystemProgram.programId,
              },
              signers: [reporter],
            }
          ),
        "167: The given account is not owned by the executing program"
      );
    }
  );

  it.each(Object.keys(ASSETS))(
    "Inactive reporter can't create asset '%s'",
    async (key: keyof typeof ASSETS) => {
      const asset = ASSETS[key];

      const reporter = REPORTERS[asset.reporter].keypair;

      const [networkAccount] = await program.findNetworkAddress(
        community.publicKey,
        asset.network
      );

      const [assetAccount, bump] = await program.findAssetAddress(
        networkAccount,
        asset.mint,
        asset.assetId
      );

      const [reporterAccount] = await program.findReporterAddress(
        community.publicKey,
        reporter.publicKey
      );

      const [caseAccount] = await program.findCaseAddress(
        community.publicKey,
        asset.caseId
      );

      await expectThrowError(
        () =>
          program.rpc.createAsset(
            asset.mint,
            asset.assetId,
            Category[asset.category],
            asset.risk,
            bump,
            {
              accounts: {
                sender: reporter.publicKey,
                asset: assetAccount,
                community: community.publicKey,
                network: networkAccount,
                reporter: reporterAccount,
                case: caseAccount,
                systemProgram: web3.SystemProgram.programId,
              },
              signers: [reporter],
            }
          ),
        "167: The given account is not owned by the executing program"
      );
    }
  );

  it.each(Object.keys(REPORTERS))("Reporter %s is activated", async (key) => {
    const reporter = REPORTERS[key];

    const [reporterAccount] = await program.findReporterAddress(
      community.publicKey,
      reporter.keypair.publicKey
    );

    const tokenAccount = await stakeToken.getTokenAccount(
      reporter.keypair.publicKey
    );

    const communityInfo = await program.account.community.fetch(
      community.publicKey
    );

    const tx = await program.rpc.activateReporter({
      accounts: {
        sender: reporter.keypair.publicKey,
        community: community.publicKey,
        reporter: reporterAccount,
        stakeMint: stakeToken.mintAccount,
        reporterTokenAccount: tokenAccount,
        communityTokenAccount: communityInfo.tokenAccount,
        tokenProgram: stakeToken.programId,
      },
      signers: [reporter.keypair],
    });

    expect(tx).toBeTruthy();

    const fetchedReporterAccount = await program.account.reporter.fetch(
      reporterAccount
    );
    expect(fetchedReporterAccount.role).toEqual(ReporterRole[reporter.type]);
    expect(fetchedReporterAccount.status).toEqual(ReporterStatus.Active);

    let stake: u64;
    if (reporter.type === "Validator") {
      stake = new u64(1_000);
    } else if (reporter.type === "Tracer") {
      stake = new u64(2_000);
    } else if (reporter.type === "Full") {
      stake = new u64(3_000);
    } else if (reporter.type === "Authority") {
      stake = new u64(4_000);
    } else {
      throw new Error("Invalid reporter type");
    }

    const balance = await stakeToken.getBalance(reporter.keypair.publicKey);
    expect(balance.add(stake).toString(10)).toEqual("1000000");
  });

  it.each(Object.keys(CASES))(
    "Case '%s' is created",
    async (key: keyof typeof CASES) => {
      const cs = CASES[key];

      const reporter = REPORTERS[cs.reporter].keypair;
      const caseName = bufferFromString(cs.name, 32);

      const [caseAccount, bump] = await program.findCaseAddress(
        community.publicKey,
        cs.caseId
      );

      const [reporterAccount] = await program.findReporterAddress(
        community.publicKey,
        reporter.publicKey
      );

      const tx = await program.rpc.createCase(
        cs.caseId,
        caseName.toJSON().data,
        bump,
        {
          accounts: {
            reporter: reporterAccount,
            sender: reporter.publicKey,
            community: community.publicKey,
            case: caseAccount,
            systemProgram: web3.SystemProgram.programId,
          },
          signers: [reporter],
        }
      );

      expect(tx).toBeTruthy();

      const fetchedCaseAccount = await program.account.case.fetch(caseAccount);
      expect(Buffer.from(fetchedCaseAccount.name)).toEqual(caseName);
      expect(fetchedCaseAccount.bump).toEqual(bump);
      expect(fetchedCaseAccount.reporter).toEqual(reporterAccount);
      expect(fetchedCaseAccount.status).toEqual(CaseStatus.Open);
      expect(fetchedCaseAccount.id.toNumber()).toEqual(cs.caseId.toNumber());

      const communityAccount = await program.account.community.fetch(
        community.publicKey
      );
      expect(communityAccount.cases.toNumber()).toEqual(cs.caseId.toNumber());
    }
  );

  it.each(Object.keys(ADDRESSES))(
    "Address '%s' created",
    async (key: keyof typeof ADDRESSES) => {
      const addr = ADDRESSES[key];

      const reporter = REPORTERS[addr.reporter].keypair;

      const [networkAccount] = await program.findNetworkAddress(
        community.publicKey,
        addr.network
      );

      const [addressAccount, bump] = await program.findAddressAddress(
        networkAccount,
        addr.pubkey
      );

      const [reporterAccount] = await program.findReporterAddress(
        community.publicKey,
        reporter.publicKey
      );

      const [caseAccount] = await program.findCaseAddress(
        community.publicKey,
        addr.caseId
      );

      const tx = await program.rpc.createAddress(
        addr.pubkey,
        Category[addr.category],
        addr.risk,
        bump,
        {
          accounts: {
            sender: reporter.publicKey,
            address: addressAccount,
            community: community.publicKey,
            network: networkAccount,
            reporter: reporterAccount,
            case: caseAccount,
            systemProgram: web3.SystemProgram.programId,
          },
          signers: [reporter],
        }
      );

      expect(tx).toBeTruthy();

      const fetchedAddressAccount = await program.account.address.fetch(
        addressAccount
      );
      expect(fetchedAddressAccount.bump).toEqual(bump);
      expect(fetchedAddressAccount.caseId.toNumber()).toEqual(
        addr.caseId.toNumber()
      );
      expect(fetchedAddressAccount.category).toEqual(Category[addr.category]);
      expect(fetchedAddressAccount.confirmations).toEqual(0);
      expect(fetchedAddressAccount.risk).toEqual(addr.risk);
      expect(fetchedAddressAccount.community).toEqual(community.publicKey);
      expect(fetchedAddressAccount.address).toEqual(addr.pubkey);
      expect(fetchedAddressAccount.network).toEqual(networkAccount);
      expect(fetchedAddressAccount.reporter).toEqual(reporterAccount);

      const addressInfo = await provider.connection.getAccountInfoAndContext(
        addressAccount
      );
      expect(addressInfo.value.owner).toEqual(program.programId);
      expect(addressInfo.value.data).toHaveLength(148);
    }
  );

  it.each(Object.keys(ASSETS))("Asset '%s' created", async (key) => {
    const asset = ASSETS[key];

    const reporter = REPORTERS[asset.reporter].keypair;

    const [networkAccount] = await program.findNetworkAddress(
      community.publicKey,
      "ethereum"
    );

    const [assetAccount, bump] = await program.findAssetAddress(
      networkAccount,
      asset.mint,
      asset.assetId
    );

    const [reporterAccount] = await program.findReporterAddress(
      community.publicKey,
      reporter.publicKey
    );

    const [caseAccount] = await program.findCaseAddress(
      community.publicKey,
      asset.caseId
    );

    const tx = await program.rpc.createAsset(
      asset.mint,
      asset.assetId,
      Category.None,
      0,
      bump,
      {
        accounts: {
          sender: reporter.publicKey,
          asset: assetAccount,
          community: community.publicKey,
          network: networkAccount,
          reporter: reporterAccount,
          case: caseAccount,
          systemProgram: web3.SystemProgram.programId,
        },
        signers: [reporter],
      }
    );

    expect(tx).toBeTruthy();

    const fetchedAssetAccount = await program.account.asset.fetch(assetAccount);
    expect(fetchedAssetAccount.bump).toEqual(bump);
    expect(fetchedAssetAccount.caseId.toNumber()).toEqual(
      asset.caseId.toNumber()
    );
    expect(fetchedAssetAccount.category).toEqual(Category.None);
    expect(fetchedAssetAccount.confirmations).toEqual(0);
    expect(fetchedAssetAccount.risk).toEqual(0);
    expect(fetchedAssetAccount.community).toEqual(community.publicKey);
    expect(fetchedAssetAccount.mint).toEqual(asset.mint);
    expect(fetchedAssetAccount.assetId).toEqual(asset.assetId.toJSON().data);
    expect(fetchedAssetAccount.network).toEqual(networkAccount);
    expect(fetchedAssetAccount.reporter).toEqual(reporterAccount);

    const addressInfo = await provider.connection.getAccountInfoAndContext(
      assetAccount
    );
    expect(addressInfo.value.owner).toEqual(program.programId);
    expect(addressInfo.value.data).toHaveLength(180);
  });

  it.each(Object.keys(ASSETS))(
    "Reporter can't create asset '%s' twice",
    async (key: keyof typeof ASSETS) => {
      const asset = ASSETS[key];

      const reporter = REPORTERS[asset.reporter].keypair;

      const [networkAccount] = await program.findNetworkAddress(
        community.publicKey,
        asset.network
      );

      const [assetAccount, bump] = await program.findAssetAddress(
        networkAccount,
        asset.mint,
        asset.assetId
      );

      const [reporterAccount] = await program.findReporterAddress(
        community.publicKey,
        reporter.publicKey
      );

      const [caseAccount] = await program.findCaseAddress(
        community.publicKey,
        asset.caseId
      );

      await expectThrowError(
        () =>
          program.rpc.createAsset(
            asset.mint,
            asset.assetId,
            Category[asset.category],
            asset.risk,
            bump,
            {
              accounts: {
                sender: reporter.publicKey,
                asset: assetAccount,
                community: community.publicKey,
                network: networkAccount,
                reporter: reporterAccount,
                case: caseAccount,
                systemProgram: web3.SystemProgram.programId,
              },
              signers: [reporter],
            }
          ),
        /custom program error: 0x0/
      );
    }
  );

  it.each(Object.keys(REPORTERS))("Reporter %s is deactivated", async (key) => {
    const reporter = REPORTERS[key];

    const [reporterAccount] = await program.findReporterAddress(
      community.publicKey,
      reporter.keypair.publicKey
    );

    const tx = await program.rpc.deactivateReporter({
      accounts: {
        sender: reporter.keypair.publicKey,
        community: community.publicKey,
        reporter: reporterAccount,
      },
      signers: [reporter.keypair],
    });

    expect(tx).toBeTruthy();

    const fetchedReporterAccount = await program.account.reporter.fetch(
      reporterAccount
    );
    expect(fetchedReporterAccount.role).toEqual(ReporterRole[reporter.type]);
    expect(fetchedReporterAccount.status).toEqual(ReporterStatus.Unstaking);
    expect(fetchedReporterAccount.unlockEpoch.toNumber()).toBeGreaterThan(0);
  });

  it("Deactivated reporter can't create new address", async () => {
    const addr = {
      reporter: "alice",
      network: "ethereum",
      pubkey: pubkeyFromHex(
        "94df427bfa5c06a211e7c7fd0606bea32926b72cc31edd92aacaf3f2c2272bfa"
      ),
      caseId: new BN(1),
      category: "Theft",
      risk: 4,
    };

    const reporter = REPORTERS[addr.reporter].keypair;

    const [networkAccount] = await program.findNetworkAddress(
      community.publicKey,
      addr.network
    );

    const [addressAccount, bump] = await program.findAddressAddress(
      networkAccount,
      addr.pubkey
    );

    const [reporterAccount] = await program.findReporterAddress(
      community.publicKey,
      reporter.publicKey
    );

    const [caseAccount] = await program.findCaseAddress(
      community.publicKey,
      addr.caseId
    );

    await expectThrowError(
      () =>
        program.rpc.createAddress(
          addr.pubkey,
          Category[addr.category],
          addr.risk,
          bump,
          {
            accounts: {
              sender: reporter.publicKey,
              address: addressAccount,
              community: community.publicKey,
              network: networkAccount,
              reporter: reporterAccount,
              case: caseAccount,
              systemProgram: web3.SystemProgram.programId,
            },

            signers: [reporter],
          }
        ),
      "309: Invalid reporter status"
    );
  });
});
