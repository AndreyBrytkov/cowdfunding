use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("54Lq7n74BEFz9KcnjaePRV3kFF1VebGHoPEpQPj2Kbch");


#[error_code]
pub enum ErrorCode {
    #[msg("Campaign is already finalized")]
    CampaignFinalized,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("No funds available to finalize")]
    NothingToFinalize,
    #[msg("Campaign target already reached")]
    TargetAlreadyReached,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
}

#[program]
pub mod test_project {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, campaign_id: u64, target: u64) -> Result<()> {
        require!(target>0, ErrorCode::InvalidAmount);

        let campaign = &mut ctx.accounts.campaign;
        campaign.funds = 0;
        campaign.target = target;
        campaign.campaign_id = campaign_id;
        campaign.authority = ctx.accounts.creator.key();
        campaign.beneficiary = ctx.accounts.beneficiary.key();
        campaign.is_finalized = false;

        Ok(())
    }


    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let campaign = &mut ctx.accounts.campaign;
        require!(!campaign.is_finalized, ErrorCode::CampaignFinalized);

        // Remaining amount to reach target
        let remaining = campaign
            .target
            .checked_sub(campaign.funds)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(remaining > 0, ErrorCode::TargetAlreadyReached);

        // "counted" amount: we only accept up to remaining
        let counted = amount.min(remaining);

        if counted < amount {
            msg!(
                "Deposit amount reduced from {} to {} to avoid exceeding target",
                amount,
                counted
            );
        }

        // Transfer counted lamports from donor -> vault_lamports (CPI to System Program)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.donor.to_account_info(),
                    to: ctx.accounts.vault_lamports.to_account_info(),
                },
            ),
            counted,
        )?;

        // Update accounted funds
        campaign.funds = campaign
            .funds
            .checked_add(counted)
            .ok_or(ErrorCode::MathOverflow)?;

        Ok(())
    }

    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        
        // Ensure caller is the beneficiary (Anchor also checks via has_one + Signer)
        require_keys_eq!(
            ctx.accounts.beneficiary.key(),
            ctx.accounts.campaign.beneficiary,
            ErrorCode::Unauthorized
        );
        
        // Transfer exactly accounted funds from vault -> beneficiary
        let amount = ctx.accounts.campaign.funds;
        require!(amount > 0, ErrorCode::NothingToFinalize);

        // PDA signer seeds for lamports vault
        let campaign_key = ctx.accounts.campaign.key();
        let vault_lamports_seeds: &[&[u8]] = &[
            b"vault_lamports",
            campaign_key.as_ref(),
            &[ctx.bumps.vault_lamports],
        ];

        // CPI transfer signed by PDA
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault_lamports.to_account_info(),
                    to: ctx.accounts.beneficiary.to_account_info(),
                },
                &[vault_lamports_seeds],
            ),
            amount,
        )?;

        let remaining = ctx.accounts.vault_lamports.to_account_info().lamports();
        if remaining > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault_lamports.to_account_info(),
                        to: ctx.accounts.authority.to_account_info(),
                    },
                    &[vault_lamports_seeds],
                ),
                remaining,
            )?;
        }

        // Mark campaign finalized and zero out accounted funds (optional but nice)
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_finalized = true;
        campaign.funds = 0;

        // Vault will be closed automatically by Anchor because of `close = authority`
        // Any remaining lamports on vault_lamports go to authority.

        Ok(())
    }

}

#[account]
#[derive(InitSpace)]
pub struct Campaign{
   pub funds: u64,
   pub target: u64,
   pub campaign_id: u64,
   pub authority: Pubkey,
   pub beneficiary: Pubkey,
   pub is_finalized: bool
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: we only read the pubkey and store it
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", creator.key().as_ref(), &campaign_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = creator,
        space = 0,
        owner = system_program::ID,
        seeds = [b"vault_lamports", campaign.key().as_ref()],
        bump
    )]

    /// CHECK: system-owned PDA used only for lamport transfers
    pub vault_lamports: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), &campaign.campaign_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"vault_lamports", campaign.key().as_ref()],
        bump
    )]
    /// CHECK: system-owned PDA used only for lamport transfers
    pub vault_lamports: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>

}

#[derive(Accounts)]
pub struct Finalize<'info> {
    /// Beneficiary must authorize finalization
    #[account(mut)]
    pub beneficiary: Signer<'info>,

    /// Campaign creator (gets vault remainder on close)
    #[account(mut)]
    pub authority: SystemAccount<'info>,

    #[account(
        mut,
        has_one = beneficiary,
        has_one = authority,
        constraint = !campaign.is_finalized @ ErrorCode::CampaignFinalized,
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"vault_lamports", campaign.key().as_ref()],
        bump
    )]
    /// CHECK: system-owned PDA used only for lamport transfers
    pub vault_lamports: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
