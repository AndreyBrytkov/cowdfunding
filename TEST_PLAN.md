# Test Plan (localnet)

1) Initialize creates campaign + vault PDAs correctly
- Steps: initialize with target > 0 and beneficiary; fetch campaign, vault, and vault_lamports account info.
- Expected: campaign fields set (funds=0, target, authority=creator, beneficiary, is_finalized=false); vault exists and is owned by program; vault_lamports exists and is system-owned.

2) Deposit increases campaign.funds and vault lamports
- Steps: initialize, record donor + vault_lamports balances, deposit amount.
- Expected: campaign.funds increases by deposit; vault_lamports balance delta equals deposit; donor balance decreases by at least deposit (plus fees).

3) Finalize success path (beneficiary only)
- Steps: initialize, deposit, finalize with beneficiary signer.
- Expected: campaign.is_finalized=true, campaign.funds=0; beneficiary balance increases by deposit (minus fees); vault closed; vault_lamports drained.

4) Finalize unauthorized caller fails
- Steps: initialize + deposit; attempt finalize with non-beneficiary signer.
- Expected: transaction fails with Unauthorized or has_one/constraint error.

5) Double finalize / replay protection
- Steps: initialize + deposit; finalize once; attempt finalize again.
- Expected: second finalize fails with CampaignFinalized or constraint error.

6) Deposit of 0 lamports should fail
- Steps: initialize; call deposit(0).
- Expected: InvalidAmount error.

7) Deposit after finalize should fail
- Steps: initialize + deposit; finalize; call deposit(>0).
- Expected: CampaignFinalized error.

8) Mismatch seeds: wrong vault PDA
- Steps: initialize two campaigns; attempt deposit into campaign A using vault B.
- Expected: seeds constraint violation.
