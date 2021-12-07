use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Reporter {
    /// Community account, which this reporter belongs to
    pub community: Pubkey,

    /// Seed bump for PDA
    pub bump: u8,

    /// If this is true, reporter can't interact with the contract
    pub is_frozen: bool,

    /// Reporter account status
    pub status: ReporterStatus,

    /// Reporter's type
    pub role: ReporterRole,

    /// Reporter's wallet account
    pub pubkey: Pubkey,

    /// Short reporter description
    pub name: [u8; 32],

    /// Current deposited stake
    pub stake: u64,

    /// Reporter can unstake at this epoch (0 if unstaking hasn't been requested)
    pub unlock_epoch: u64,
}

#[derive(Clone, PartialEq, AnchorDeserialize, AnchorSerialize)]
pub enum ReporterStatus {
    /// Reporter is not active, but can activate after staking
    Inactive,

    /// Reporter is active and can report
    Active,

    /// Reporter has requested unstaking and can't report
    Unstaking,
}

impl Default for ReporterStatus {
    fn default() -> Self {
        ReporterStatus::Inactive
    }
}

#[derive(Clone, PartialEq, AnchorDeserialize, AnchorSerialize)]
pub enum ReporterRole {
    /// Validator - can validate addresses
    Validator = 0,

    /// Tracer - can report and validate addresses
    Tracer = 1,

    /// Full - can report cases and addresses
    Full = 2,

    /// Authority - can report and modify cases and addresses
    Authority = 3,
}

impl Default for ReporterRole {
    fn default() -> Self {
        ReporterRole::Validator
    }
}
