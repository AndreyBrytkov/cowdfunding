# Program Review Report

## Findings

### Critical
1) `beneficiary` is not marked writable in `Finalize`
- Location: `programs/test_project/src/lib.rs` `Finalize` accounts.
- Issue: `beneficiary` is a `Signer` but not `#[account(mut)]`. The CPI to System Program transfer requires the `to` account to be writable. This causes a writable privilege escalation failure at runtime.
- Impact: `finalize` fails during CPI, preventing funds from being paid out.
- Evidence: `anchor test` fails with “Cross-program invocation with unauthorized signer or writable account” and log “writable privilege escalated”.

2) Vault is program-owned but used as the `from` account in a System Program transfer
- Location: `programs/test_project/src/lib.rs` `Vault` account definition and `finalize`.
- Issue: `vault` is defined as `Account<Vault>` (program-owned with data), yet `finalize` calls `system_program::transfer` with `from: vault`. The System Program typically requires the `from` account to be system-owned (no data).
- Impact: even if writable privileges are corrected, `finalize` is likely to fail or be rejected by the System Program, leaving funds locked.
- Repro: initialize + deposit, then call finalize; expect CPI failure.

### Medium
3) Unsolicited lamports sent to the vault are not tracked and are redirected to authority on close
- Location: `programs/test_project/src/lib.rs` `deposit` + `finalize`.
- Issue: `campaign.funds` only tracks deposits made through `deposit`. Any lamports sent directly to the vault PDA are not counted and are not transferred to the beneficiary on finalize.
- Impact: accidental or third-party transfers to the vault will not reach the beneficiary; those lamports go to `authority` when the vault closes.
- Repro: transfer lamports directly to the vault, then finalize; beneficiary only receives `campaign.funds` while remainder goes to authority.

4) Campaign PDA seed is not enforced in `deposit`
- Location: `programs/test_project/src/lib.rs` `Deposit` accounts.
- Issue: `deposit` accepts any `Campaign` account (no seed constraint), so callers can supply a program-owned Campaign account not derived from the intended PDA seeds.
- Impact: weakens address integrity expectations; tooling might assume the PDA derivation but the program does not enforce it.
- Repro: create a Campaign account with correct layout but arbitrary address; deposit will accept it as long as the vault PDA matches that address.

### Low
5) Error codes do not precisely match conditions
- Location: `programs/test_project/src/lib.rs` `finalize`.
- Issue: `finalize` uses `TargetAlreadyReached` when `campaign.funds == 0`.
- Impact: confusing error reporting; makes client error handling ambiguous.

## Notes
- The `initialize` instruction accepts `campaign_id` but does not store it, so it is not recoverable from on-chain state.
- Closing the vault sends rent/extra lamports to `authority` rather than `beneficiary` (intentional per comment, but may surprise users).
