import {
  Provider,
  Program,
  Wallet,
  utils,
  Coder,
  Idl,
  IdlAccounts,
  IdlTypes,
} from "@project-serum/anchor";
import {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  Signer,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

// To prevent a potential race condition, prior to using the variable wasm,
// you need to run:
//        if (wasm == undefined)
//           await ensureWasmLoaded;
// (it's also okay to do it unconditionally)

// This seems to work for now, but I am not sure how fragile it is.
const useNode =
  typeof process !== undefined &&
  process.env.hasOwnProperty("_") &&
  !process.env._.includes("next");
// console.log("Using node WASM version? " + useNode);
let wasm;
let ensureWasmLoaded: Promise<void>;
if (useNode) {
  // This needs to be sufficiently complicated that the bundler can't compute its value
  // It means the bundler will give us a warning "the request of a dependency is an expression"
  // because it doesn't understand that it will never encounter a case in which useNode is true.
  // When normal node is running, it doesn't care that this is an expression.
  const path = useNode ? "../../staking/wasm/" + "node" + "/staking" : "BAD";
  wasm = require(path);
  ensureWasmLoaded = Promise.resolve();
} else {
  const f = async () => {
    wasm = await require("../../staking/wasm/bundle/staking");
  };
  ensureWasmLoaded = f();
}

import { sha256 } from "js-sha256";
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes";
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  u64,
} from "@solana/spl-token";
import BN from "bn.js";
import * as idljs from "@project-serum/anchor/dist/cjs/coder/borsh/idl";
import { Staking } from "../../staking/target/types/staking";

type GlobalConfig = IdlAccounts<Staking>["globalConfig"];
type PositionData = IdlAccounts<Staking>["positionData"];
type StakeAccountMetadata = IdlAccounts<Staking>["stakeAccountMetadata"];
type VestingSchedule = IdlTypes<Staking>["VestingSchedule"];

export class StakeConnection {
  program: Program<Staking>;
  config: GlobalConfig;

  // creates a program connection and loads the staking config
  // the constructor cannot be async so we use a static method
  public static async createStakeConnection(
    connection: Connection,
    wallet: Wallet,
    address: PublicKey
  ): Promise<StakeConnection> {
    const stake_connection = new StakeConnection();
    const provider = new Provider(connection, wallet, {});
    const idl = await Program.fetchIdl(address, provider);
    stake_connection.program = new Program(
      idl,
      address,
      provider
    ) as Program<Staking>;

    const config_address = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("config")],
        stake_connection.program.programId
      )
    )[0];

    stake_connection.config =
      await stake_connection.program.account.globalConfig.fetch(config_address);
    return stake_connection;
  }

  //gets a users stake accounts
  public async getStakeAccounts(user: PublicKey): Promise<StakeAccount[]> {
    const discriminator = Buffer.from(
      sha256.digest(`account:PositionData`)
    ).slice(0, 8);

    const res = await this.program.provider.connection.getProgramAccounts(
      this.program.programId,
      {
        encoding: "base64",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(discriminator),
            },
          },
          {
            memcmp: {
              offset: 8,
              bytes: user.toBase58(),
            },
          },
        ],
      }
    );
    return await Promise.all(
      res.map(async (account) => {
        return await this.loadStakeAccount(account.pubkey);
      })
    );
  }

  // creates stake account will happen inside deposit
  // public async createStakeAccount(user: PublicKey): Promise<StakeAccount> {
  //   return;
  // }

  async fetchPositionAccount(address: PublicKey) {
    if (wasm == undefined) await ensureWasmLoaded;
    const inbuf = await this.program.provider.connection.getAccountInfo(
      address
    );
    const pd = new wasm.WasmPositionData(inbuf.data);
    const outBuffer = Buffer.alloc(pd.borshLength);
    pd.asBorsh(outBuffer);
    const positions = this.program.coder.accounts.decode(
      "PositionData",
      outBuffer
    );
    return [pd, positions];
  }

  //stake accounts are loaded by a StakeConnection object
  public async loadStakeAccount(address: PublicKey): Promise<StakeAccount> {
    const stake_account = new StakeAccount();
    stake_account.config = this.config;

    stake_account.address = address;
    [
      stake_account.stakeAccountPositionsWasm,
      stake_account.stakeAccountPositionsJs,
    ] = await this.fetchPositionAccount(address);

    const metadata_address = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("stake_metadata"), address.toBuffer()],
        this.program.programId
      )
    )[0];

    stake_account.stake_account_metadata =
      (await this.program.account.stakeAccountMetadata.fetch(
        metadata_address
      )) as any as StakeAccountMetadata; // TS complains about types. Not exactly sure why they're incompatible.
    stake_account.vestingSchedule = StakeAccount.serializeVesting(
      stake_account.stake_account_metadata.lock,
      this.program.idl
    );

    const custody_address = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("custody"), address.toBuffer()],
        this.program.programId
      )
    )[0];

    stake_account.authority_address = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("authority"), address.toBuffer()],
        this.program.programId
      )
    )[0];

    const mint = new Token(
      this.program.provider.connection,
      this.config.pythTokenMint,
      TOKEN_PROGRAM_ID,
      new Keypair()
    );
    stake_account.token_balance = (
      await mint.getAccountInfo(custody_address)
    ).amount;
    return stake_account;
  }

  //unlock a provided token balance
  public async unlockTokens(
    stake_account: StakeAccount,
    amount: number,
    program: Program
  ) {}

  private async withCreateAccount(
    instructions: TransactionInstruction[],
    owner: PublicKey
  ): Promise<Keypair> {
    const stake_account_keypair = new Keypair();

    const stakeAccountMetadata = (
      await PublicKey.findProgramAddress(
        [
          utils.bytes.utf8.encode("stake_metadata"),
          stake_account_keypair.publicKey.toBuffer(),
        ],
        this.program.programId
      )
    )[0];

    const stakeAccountCustody = (
      await PublicKey.findProgramAddress(
        [
          utils.bytes.utf8.encode("custody"),
          stake_account_keypair.publicKey.toBuffer(),
        ],
        this.program.programId
      )
    )[0];

    const custodyAuthority = (
      await PublicKey.findProgramAddress(
        [
          utils.bytes.utf8.encode("authority"),
          stake_account_keypair.publicKey.toBuffer(),
        ],
        this.program.programId
      )
    )[0];

    const voterRecord = (
      await PublicKey.findProgramAddress(
        [
          utils.bytes.utf8.encode("voter_weight"),
          stake_account_keypair.publicKey.toBuffer(),
        ],
        this.program.programId
      )
    )[0];

    const config = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("config")],
        this.program.programId
      )
    )[0];

    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: stake_account_keypair.publicKey,
        lamports:
          await this.program.provider.connection.getMinimumBalanceForRentExemption(
            wasm.Constants.POSITIONS_ACCOUNT_SIZE()
          ),
        space: wasm.Constants.POSITIONS_ACCOUNT_SIZE(),
        programId: this.program.programId,
      })
    );

    instructions.push(
      this.program.instruction.createStakeAccount(
        owner,
        { fullyVested: {} },
        {
          accounts: {
            payer: owner,
            stakeAccountMetadata,
            stakeAccountCustody,
            stakeAccountPositions: stake_account_keypair.publicKey,
            custodyAuthority,
            mint: this.config.pythTokenMint,
            voterRecord,
            config,
            rent: SYSVAR_RENT_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
        }
      )
    );

    return stake_account_keypair;
  }
  //deposit tokens
  public async depositAndLockTokens(
    stake_account: StakeAccount | undefined,
    amount: number
  ) {
    let stake_account_address: PublicKey;
    const owner = this.program.provider.wallet.publicKey;

    const ata = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      this.config.pythTokenMint,
      owner
    );

    const ixs: TransactionInstruction[] = [];
    const signers: Signer[] = [];

    if (!stake_account) {
      const stake_account_keypair = await this.withCreateAccount(ixs, owner);
      signers.push(stake_account_keypair);
      stake_account_address = stake_account_keypair.publicKey;
    } else {
      stake_account_address = stake_account.address;
    }

    const toAccount = (
      await PublicKey.findProgramAddress(
        [utils.bytes.utf8.encode("custody"), stake_account_address.toBuffer()],
        this.program.programId
      )
    )[0];

    ixs.push(
      Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        ata,
        toAccount,
        owner,
        [],
        amount
      )
    );

    await this.program.methods
      .createPosition(null, null, new BN(amount))
      .preInstructions(ixs)
      .accounts({
        stakeAccountPositions: stake_account_address,
      })
      .signers(signers)
      .rpc({ skipPreflight: true });
  }

  //withdraw tokens
  public async withdrawTokens(
    stake_account: StakeAccount,
    amount: number,
    program: Program
  ) {}
}
export interface BalanceSummary {
  withdrawable: BN;
  // We may break this down into active, warmup, and cooldown in the future
  locked: BN;
  unvested: BN;
}

export class StakeAccount {
  address: PublicKey;
  stakeAccountPositionsWasm: wasm.WasmPositionData;
  stakeAccountPositionsJs: PositionData;
  stake_account_metadata: StakeAccountMetadata;
  token_balance: u64;
  authority_address: PublicKey;
  vestingSchedule: Buffer; // Borsh serialized
  config: GlobalConfig;

  // Withdrawable

  //Locked tokens :
  // - warmup
  // - active
  // - cooldown

  // Unvested

  public getBalanceSummary(unixTime: BN): BalanceSummary {
    let unvestedBalance = wasm.getUnvestedBalance(
      this.vestingSchedule,
      BigInt(unixTime.toString())
    );
    let currentEpoch = unixTime.div(this.config.epochDuration);
    let unlockingDuration = this.config.unlockingDuration;

    const withdrawable = this.stakeAccountPositionsWasm.getWithdrawable(
      BigInt(this.token_balance.toString()),
      unvestedBalance,
      BigInt(currentEpoch.toString()),
      unlockingDuration
    );
    const withdrawableBN = new BN(withdrawable.toString());
    const unvestedBN = new BN(unvestedBalance.toString());
    return {
      withdrawable: withdrawableBN,
      locked: this.token_balance.sub(withdrawableBN).sub(unvestedBN),
      unvested: unvestedBN,
    };
  }

  // What is the best way to represent current vesting schedule in the UI
  public getVestingSchedule() {}

  static serializeVesting(lock: VestingSchedule, idl: Idl): Buffer {
    const VESTING_SCHED_MAX_BORSH_LEN = 4 * 8 + 1;
    let buffer = Buffer.alloc(VESTING_SCHED_MAX_BORSH_LEN);

    let idltype = idl.types.find((v) => v.name === "VestingSchedule");
    const vestingSchedLayout = idljs.IdlCoder.typeDefLayout(idltype, idl.types);
    const length = vestingSchedLayout.encode(lock, buffer, 0);
    return buffer.slice(0, length);
  }
}