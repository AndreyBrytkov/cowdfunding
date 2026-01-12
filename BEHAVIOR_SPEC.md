# Behavior Spec (from on-chain code)

## Program overview
A campaign/escrow flow with one program PDA and one system-owned PDA:
- Campaign PDA: stores campaign state (authority, beneficiary, target, funds, finalized flag, campaign_id).
- Vault lamports PDA (system-owned): holds lamports contributed to the campaign.

## Instructions and accounts
### initialize(campaign_id: u64, target: u64)
- Accounts:
  - creator: Signer (payer)
  - beneficiary: UncheckedAccount (stored in campaign)
  - campaign: PDA init with seeds ["campaign", creator, campaign_id], payer=creator
  - vault_lamports: system-owned PDA init with seeds ["vault_lamports", campaign], payer=creator
  - system_program
- Behavior:
  - Requires target > 0
  - Sets campaign.funds = 0, target, authority = creator, beneficiary, is_finalized = false
  - Stores campaign.campaign_id

### deposit(amount: u64)
- Accounts:
  - donor: Signer (payer for transfer)
  - campaign: Campaign PDA (mut) seeds ["campaign", authority, campaign_id]
  - vault_lamports: SystemAccount PDA (mut) seeds ["vault_lamports", campaign]
  - system_program
- Behavior:
  - Requires amount > 0
  - Requires campaign.is_finalized == false
  - Calculates remaining = target - funds; requires remaining > 0
  - Uses counted = min(amount, remaining)
  - Transfers counted lamports donor -> vault_lamports
  - Adds counted to campaign.funds

### finalize()
- Accounts:
  - beneficiary: Signer
  - authority: SystemAccount (mut)
  - campaign: Campaign (mut), has_one beneficiary, has_one authority, not finalized
  - vault_lamports: SystemAccount PDA (mut), seeds ["vault_lamports", campaign]
  - system_program
- Behavior:
  - Requires beneficiary matches campaign.beneficiary
  - Requires campaign.funds > 0
  - Transfers campaign.funds from vault_lamports -> beneficiary using vault_lamports PDA signer seeds
  - Transfers any remaining lamports from vault_lamports -> authority
  - Sets campaign.is_finalized = true; campaign.funds = 0

## State
- Campaign:
  - funds: u64 (accounted deposits)
  - target: u64 (goal)
  - campaign_id: u64 (seed component)
  - authority: Pubkey (creator)
  - beneficiary: Pubkey
  - is_finalized: bool
- Vault lamports: system account PDA holding lamports

## Key invariants (intended by code)
- target must be > 0 at initialization
- deposit amount must be > 0
- deposits stop after is_finalized or when funds >= target
- campaign.funds increases only by counted deposits
- finalize requires beneficiary signer and not already finalized
- finalize transfers exactly campaign.funds to beneficiary and zeroes funds
- vault_lamports PDA holds lamports and is drained on finalize
