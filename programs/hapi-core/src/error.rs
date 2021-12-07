use anchor_lang::prelude::*;

#[error]
pub enum ErrorCode {
    #[msg("Unexpected account has been used")]
    UnexpectedAccount,
    #[msg("Account is not authorized to perform this action")]
    Unauthorized,
    #[msg("Non-sequential case ID")]
    NonSequentialCaseId,
    #[msg("Release epoch is in future")]
    ReleaseEpochInFuture,
    #[msg("Invalid mint account")]
    InvalidMint,
    #[msg("Invalid reporter account")]
    InvalidReporter,
    #[msg("Reporter account is not active")]
    InactiveReporter,
    #[msg("Invalid token account")]
    InvalidToken,
    #[msg("Case closed")]
    CaseClosed,
    #[msg("Invalid reporter status")]
    InvalidReporterStatus,
    #[msg("Authority mismatched")]
    AuthorityMismatch,
    #[msg("Community mismatched")]
    CommunityMismatch,
    #[msg("This reporter is frozen")]
    FrozenReporter,
    #[msg("Risk score must be in 0..10 range")]
    RiskOutOfRange,
    #[msg("Network mismatched")]
    NetworkMismatch,
    #[msg("Case mismatched")]
    CaseMismatch,
}

pub fn print_error(error: ErrorCode) -> ProgramResult {
    msg!("Error: {}", error);
    Err(error.into())
}
