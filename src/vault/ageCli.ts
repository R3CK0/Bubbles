import { spawnSync } from "node:child_process";

/**
 * Thin wrappers around the `age` and `age-plugin-yubikey` binaries.
 *
 * We shell out to these (well-audited, actively maintained) tools rather than
 * re-implementing PIV/HMAC key wrapping ourselves. All calls use argv arrays
 * (never a shell string), so there is no command-injection surface even
 * though some inputs (names, recipients) could theoretically be attacker
 * influenced.
 *
 * Decrypt operations require the physical YubiKey to be present and will
 * block on a PIN prompt / touch, which age-plugin-yubikey reads directly
 * from /dev/tty (independent of this process's stdio), so it works even
 * though we pipe stdin/stdout for the ciphertext/plaintext.
 */

export const AGE_BIN = "age";
export const AGE_PLUGIN_YUBIKEY_BIN = "age-plugin-yubikey";

export class AgeToolError extends Error {}

function run(
  bin: string,
  args: string[],
  opts: { input?: Buffer; inheritStderr?: boolean; inheritStdin?: boolean } = {},
) {
  const result = spawnSync(bin, args, {
    input: opts.inheritStdin ? undefined : opts.input,
    stdio: [
      opts.inheritStdin ? "inherit" : "pipe",
      "pipe",
      opts.inheritStderr === false ? "pipe" : "inherit",
    ],
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new AgeToolError(
        `'${bin}' is not installed or not on PATH. Install it with: brew install age age-plugin-yubikey`,
      );
    }
    throw new AgeToolError(`Failed to run '${bin}': ${err.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
    throw new AgeToolError(
      `'${bin} ${args.join(" ")}' exited with code ${result.status}.${stderr ? ` ${stderr}` : ""}`,
    );
  }

  return result.stdout;
}

export function checkAgeToolsInstalled(): void {
  run(AGE_BIN, ["--version"], { inheritStderr: false });
  run(AGE_PLUGIN_YUBIKEY_BIN, ["--version"], { inheritStderr: false });
}

export interface GenerateIdentityOptions {
  slot?: number;
  touchPolicy?: "always" | "cached" | "never";
  pinPolicy?: "always" | "once" | "never";
  name?: string;
}

/**
 * Generates a brand-new PIV identity on the inserted YubiKey. The private
 * key material never leaves the hardware; this only returns a reference
 * ("identity") the age plugin uses to talk to that specific key + slot again.
 *
 * Requires the YubiKey to be inserted. May prompt interactively on the
 * terminal (slot selection, PIN setup) so stdin/stderr are inherited here.
 */
export function generateYubikeyIdentity(opts: GenerateIdentityOptions = {}): {
  identity: string;
  recipient: string;
  raw: string;
} {
  const args = ["--generate"];
  if (opts.slot !== undefined) args.push("--slot", String(opts.slot));
  args.push("--touch-policy", opts.touchPolicy ?? "always");
  args.push("--pin-policy", opts.pinPolicy ?? "once");
  if (opts.name) args.push("--name", opts.name);

  const stdout = run(AGE_PLUGIN_YUBIKEY_BIN, args, { inheritStdin: true }).toString("utf8");

  const recipient = stdout.match(/^#\s*recipient:\s*(age1yubikey1\S+)/im)?.[1];
  const identity = stdout.match(/^(AGE-PLUGIN-YUBIKEY-\S+)/m)?.[1];

  if (!recipient || !identity) {
    throw new AgeToolError(
      `Could not parse age-plugin-yubikey output. Raw output:\n${stdout}`,
    );
  }

  return { identity, recipient, raw: stdout };
}

export function listYubikeyIdentities(): string {
  return run(AGE_PLUGIN_YUBIKEY_BIN, ["--list"], { inheritStderr: false }).toString("utf8");
}

/** Encrypts plaintext to the given age recipient. No hardware interaction needed. */
export function encryptToRecipient(recipient: string, plaintext: Buffer): Buffer {
  return run(AGE_BIN, ["-r", recipient, "-a"], { input: plaintext, inheritStderr: false });
}

/**
 * Decrypts ciphertext using a YubiKey-backed identity file.
 * BLOCKS waiting for PIN entry + physical touch on the YubiKey.
 */
export function decryptWithIdentity(identityFilePath: string, ciphertext: Buffer): Buffer {
  return run(AGE_BIN, ["-d", "-i", identityFilePath], { input: ciphertext });
}
