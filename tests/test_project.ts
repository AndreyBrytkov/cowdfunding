import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";

import { TestProject } from "../target/types/test_project";

function u64leBN(n: anchor.BN): Buffer {
  const b = Buffer.alloc(8);
  const bi = BigInt(n.toString());
  b.writeBigUInt64LE(bi);
  return b;
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.TestProject as Program<TestProject>;

let campaignCounter = 1;
function nextCampaignId(): anchor.BN {
  return new anchor.BN(campaignCounter++);
}

async function airdrop(pubkey: PublicKey, lamports = 2 * LAMPORTS_PER_SOL) {
  const sig = await provider.connection.requestAirdrop(pubkey, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function findCampaignPda(creator: PublicKey, campaignId: anchor.BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), u64leBN(campaignId)],
    program.programId
  );
  return pda;
}

function findVaultLamportsPda(campaignPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_lamports"), campaignPda.toBuffer()],
    program.programId
  );
  return pda;
}

async function initCampaign(params: {
  creator: Keypair;
  beneficiary: PublicKey;
  targetLamports: number;
}) {
  const campaignId = nextCampaignId();
  const target = new anchor.BN(params.targetLamports);

  const campaignPda = findCampaignPda(params.creator.publicKey, campaignId);
  const vaultLamportsPda = findVaultLamportsPda(campaignPda);

  await program.methods
    .initialize(campaignId, target)
    .accounts({
      creator: params.creator.publicKey,
      beneficiary: params.beneficiary,
      campaign: campaignPda,
      vaultLamports: vaultLamportsPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { campaignId, campaignPda, vaultLamportsPda, target };
}

async function expectError(p: Promise<unknown>, matcher: RegExp) {
  try {
    await p;
    assert.fail("Expected transaction to fail");
  } catch (err) {
    const msg = String(err);
    assert.match(msg, matcher);
  }
}

describe("test_project", () => {
  const creator = (provider.wallet as anchor.Wallet).payer;

  it("initialize creates campaign + vault lamports PDA with expected state", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaign.funds.toString(), "0");
    assert.equal(campaign.target.toString(), targetLamports.toString());
    assert.equal(campaign.authority.toBase58(), creator.publicKey.toBase58());
    assert.equal(
      campaign.beneficiary.toBase58(),
      beneficiary.publicKey.toBase58()
    );
    assert.equal(campaign.isFinalized, false);

    const vaultLamportsInfo = await provider.connection.getAccountInfo(
      vaultLamportsPda
    );
    assert.isNotNull(vaultLamportsInfo, "vault lamports should exist");
    assert.equal(
      vaultLamportsInfo?.owner.toBase58(),
      SystemProgram.programId.toBase58()
    );
  });

  it("deposit increases campaign.funds and vault lamports", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const depositLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    const donorBalanceBefore = await provider.connection.getBalance(
      creator.publicKey
    );
    const vaultBalanceBefore = await provider.connection.getBalance(
      vaultLamportsPda
    );

    await program.methods
      .deposit(new anchor.BN(depositLamports))
      .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaign.funds.toString(), depositLamports.toString());

    const vaultBalanceAfter = await provider.connection.getBalance(
      vaultLamportsPda
    );
    assert.equal(vaultBalanceAfter - vaultBalanceBefore, depositLamports);

    const donorBalanceAfter = await provider.connection.getBalance(
      creator.publicKey
    );
    assert.ok(
      donorBalanceAfter <= donorBalanceBefore - depositLamports,
      "donor should pay at least the deposit amount (plus fees)"
    );
  });

  it("finalize transfers funds to beneficiary and closes vault", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const depositLamports = Math.floor(0.02 * LAMPORTS_PER_SOL);

    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    await program.methods
      .deposit(new anchor.BN(depositLamports))
      .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const beneficiaryBalanceBefore = await provider.connection.getBalance(
      beneficiary.publicKey
    );

    await program.methods
      .finalize()
      .accounts({
        beneficiary: beneficiary.publicKey,
        authority: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([beneficiary])
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaign.isFinalized, true);
    assert.equal(campaign.funds.toString(), "0");

    const beneficiaryBalanceAfter = await provider.connection.getBalance(
      beneficiary.publicKey
    );
    const delta = beneficiaryBalanceAfter - beneficiaryBalanceBefore;
    const feeBuffer = 20_000;
    assert.ok(
      delta >= depositLamports - feeBuffer,
      "beneficiary balance should increase by deposited funds minus fees"
    );

    const vaultLamportsAfter = await provider.connection.getBalance(
      vaultLamportsPda
    );
    assert.equal(vaultLamportsAfter, 0);
  });

  it("finalize rejects unauthorized caller", async () => {
    const beneficiary = Keypair.generate();
    const unauthorized = Keypair.generate();
    await airdrop(beneficiary.publicKey);
    await airdrop(unauthorized.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const depositLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    await program.methods
      .deposit(new anchor.BN(depositLamports))
      .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await expectError(
      program.methods
        .finalize()
        .accounts({
          beneficiary: unauthorized.publicKey,
          authority: creator.publicKey,
          campaign: campaignPda,
          vaultLamports: vaultLamportsPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorized])
        .rpc(),
      /Unauthorized|has one|ConstraintHasOne/i
    );
  });

  it("double finalize is rejected", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const depositLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    await program.methods
      .deposit(new anchor.BN(depositLamports))
      .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .finalize()
      .accounts({
        beneficiary: beneficiary.publicKey,
        authority: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([beneficiary])
      .rpc();

    await expectError(
      program.methods
        .finalize()
        .accounts({
          beneficiary: beneficiary.publicKey,
          authority: creator.publicKey,
          campaign: campaignPda,
          vaultLamports: vaultLamportsPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([beneficiary])
        .rpc(),
      /CampaignFinalized|Constraint.*finalized|AccountNotInitialized|AccountNotFound|closed/i
    );
  });

  it("deposit of zero lamports is rejected", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    await expectError(
      program.methods
        .deposit(new anchor.BN(0))
        .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
      /InvalidAmount/i
    );
  });

  it("deposit after finalize is rejected", async () => {
    const beneficiary = Keypair.generate();
    await airdrop(beneficiary.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const depositLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

    const { campaignPda, vaultLamportsPda } = await initCampaign({
      creator,
      beneficiary: beneficiary.publicKey,
      targetLamports,
    });

    await program.methods
      .deposit(new anchor.BN(depositLamports))
      .accounts({
        donor: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .finalize()
      .accounts({
        beneficiary: beneficiary.publicKey,
        authority: creator.publicKey,
        campaign: campaignPda,
        vaultLamports: vaultLamportsPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([beneficiary])
      .rpc();

    await expectError(
      program.methods
        .deposit(new anchor.BN(1))
        .accounts({
          donor: creator.publicKey,
          campaign: campaignPda,
          vaultLamports: vaultLamportsPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      /CampaignFinalized|AccountNotInitialized|AccountNotFound|closed/i
    );
  });

  it("mismatched vault lamports seed is rejected", async () => {
    const beneficiaryA = Keypair.generate();
    const beneficiaryB = Keypair.generate();
    await airdrop(beneficiaryA.publicKey);
    await airdrop(beneficiaryB.publicKey);

    const targetLamports = Math.floor(0.05 * LAMPORTS_PER_SOL);

    const {
      campaignPda: campaignA,
      vaultLamportsPda: vaultLamportsA,
    } = await initCampaign({
      creator,
      beneficiary: beneficiaryA.publicKey,
      targetLamports,
    });

    const {
      campaignPda: campaignB,
      vaultLamportsPda: vaultLamportsB,
    } = await initCampaign({
      creator,
      beneficiary: beneficiaryB.publicKey,
      targetLamports,
    });

    await expectError(
      program.methods
        .deposit(new anchor.BN(1_000))
        .accounts({
          donor: creator.publicKey,
          campaign: campaignA,
          vaultLamports: vaultLamportsB,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      /ConstraintSeeds|seeds constraint/i
    );
  });
});
