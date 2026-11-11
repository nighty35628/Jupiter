import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONFIG_ENVELOPE_VERSION,
  MAX_CONFIG_ENVELOPE_BYTES,
  MAX_CONFIG_JSON_BYTES,
  decodeConfigEnvelope,
  encodeConfigEnvelope,
} from "../src/mobile/config-envelope.js";

const KEY = Buffer.alloc(32, 0x42);
const CONFIG = JSON.stringify(
  {
    providers: [{ endpoint: "https://example.test/v1", apiKey: "secret-api-key", model: "test" }],
    providerVersion: 7,
    nested: { enabled: true, empty: null, values: [1, "\u4e2d\u6587", false] },
  },
  null,
  2,
);

// Independent producer exercises authenticated payloads that encode must refuse.
function seal(plaintext: string | Buffer, aad = "JupiterAndroidConfig:v1"): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext),
    cipher.final(),
  ]);
  return JSON.stringify({
    format: "JupiterAndroidConfig",
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}

function editEnvelope(edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(encodeConfigEnvelope(CONFIG, KEY)) as Record<string, unknown>;
  edit(value);
  return JSON.stringify(value);
}

describe("Android config envelope", { retry: 0 }, () => {
  it("synchronously preserves the complete config JSON without mutating caller state", () => {
    const beforeKey = Buffer.from(KEY);
    const beforeEnv = { ...process.env };
    const beforeArgv = [...process.argv];
    const envelope = encodeConfigEnvelope(CONFIG, KEY);
    expect(typeof envelope).toBe("string");
    expect(envelope).not.toContain("secret-api-key");
    expect(envelope).not.toContain("example.test");
    expect(decodeConfigEnvelope(envelope, KEY)).toBe(CONFIG);
    expect(KEY).toEqual(beforeKey);
    expect(process.env).toEqual(beforeEnv);
    expect(process.argv).toEqual(beforeArgv);
  });

  it.each(["{}", ' { "x": [null, false, 1] }\n', '{"text":"\u4e2d\u6587"}'])(
    "round-trips object JSON: %s",
    (json) => {
      const key = new Uint8Array(randomBytes(32));
      expect(decodeConfigEnvelope(encodeConfigEnvelope(json, key), key)).toBe(json);
    },
  );

  it("uses a fresh 96-bit nonce and explicit v1 metadata on every encode", () => {
    const envelopes = Array.from({ length: 20 }, () => encodeConfigEnvelope(CONFIG, KEY));
    const nonces = envelopes.map((text) => {
      const value = JSON.parse(text);
      expect(Object.keys(value).sort()).toEqual(
        ["format", "version", "algorithm", "nonce", "ciphertext", "tag"].sort(),
      );
      expect(value.format).toBe("JupiterAndroidConfig");
      expect(value.version).toBe(CONFIG_ENVELOPE_VERSION);
      expect(value.algorithm).toBe("aes-256-gcm");
      expect(Buffer.from(value.nonce, "base64")).toHaveLength(12);
      expect(Buffer.from(value.tag, "base64")).toHaveLength(16);
      expect(Buffer.from(value.ciphertext, "base64")).toHaveLength(Buffer.byteLength(CONFIG));
      return value.nonce;
    });
    expect(new Set(nonces).size).toBe(20);
    expect(new Set(envelopes).size).toBe(20);
  });

  it.each([
    undefined,
    null,
    "",
    KEY.toString("hex"),
    KEY.toString("base64"),
    [...KEY],
    {},
    Buffer.alloc(0),
    Buffer.alloc(31),
    Buffer.alloc(33),
    new Uint16Array(16),
    new DataView(new ArrayBuffer(32)),
  ])("rejects absent, incorrectly sized, or incorrectly typed DEKs (%#)", (key) => {
    const dek = key as Uint8Array;
    expect(() => encodeConfigEnvelope(CONFIG, dek)).toThrow("requires a 32-byte DEK");
    expect(() => decodeConfigEnvelope(seal(CONFIG), dek)).toThrow("requires a 32-byte DEK");
  });

  it("rejects the wrong 32-byte key without exposing it", () => {
    expect(() =>
      decodeConfigEnvelope(encodeConfigEnvelope(CONFIG, KEY), Buffer.alloc(32, 0x43)),
    ).toThrow("Android config authentication failed");
  });

  it.each(["nonce", "ciphertext", "tag"])("authenticates %s against tampering", (field) => {
    const tampered = editEnvelope((value) => {
      const bytes = Buffer.from(value[field] as string, "base64");
      bytes[0] = bytes[0]! ^ 1;
      value[field] = bytes.toString("base64");
    });
    expect(() => decodeConfigEnvelope(tampered, KEY)).toThrow("authentication failed");
  });

  it("rejects truncated ciphertext even when its Base64 is still canonical", () => {
    const truncated = editEnvelope((value) => {
      value.ciphertext = Buffer.from(value.ciphertext as string, "base64")
        .subarray(0, -1)
        .toString("base64");
    });
    expect(() => decodeConfigEnvelope(truncated, KEY)).toThrow("authentication failed");
  });

  it("interoperates with an independent AES-GCM producer using the exact AAD", () => {
    expect(decodeConfigEnvelope(seal(CONFIG), KEY)).toBe(CONFIG);
  });

  it.each(["", "JupiterAndroidConfig:v2", "OtherAndroidConfig:v1"])(
    "rejects a different authenticated domain/version (%#)",
    (aad) => {
      expect(() => decodeConfigEnvelope(seal(CONFIG, aad), KEY)).toThrow("authentication failed");
    },
  );

  it.each([0, 2, -1, "1", null, false, {}, []])("rejects unsupported versions (%#)", (version) => {
    expect(() =>
      decodeConfigEnvelope(
        editEnvelope((value) => {
          value.version = version;
        }),
        KEY,
      ),
    ).toThrow("Unsupported Android config envelope version");
  });

  it.each(["format", "version", "algorithm", "nonce", "ciphertext", "tag"])(
    "rejects a missing %s field",
    (field) => {
      expect(() =>
        decodeConfigEnvelope(
          editEnvelope((value) => {
            delete value[field];
          }),
          KEY,
        ),
      ).toThrow("Invalid Android config envelope");
    },
  );

  it.each(["format", "algorithm", "nonce", "ciphertext", "tag"])(
    "rejects incorrectly typed %s fields",
    (field) => {
      for (const invalid of [null, false, 1, [], {}]) {
        expect(() =>
          decodeConfigEnvelope(
            editEnvelope((value) => {
              value[field] = invalid;
            }),
            KEY,
          ),
        ).toThrow("Invalid Android config envelope");
      }
    },
  );

  it.each([
    ["format", "OtherConfig"],
    ["algorithm", "aes-128-gcm"],
    ["extra", "secret-extra-field"],
    ["__proto__", null],
  ])("rejects altered metadata or extra fields: %s", (field, value) => {
    const envelope = JSON.parse(encodeConfigEnvelope(CONFIG, KEY));
    Object.defineProperty(envelope, field, { value, enumerable: true });
    expect(() => decodeConfigEnvelope(JSON.stringify(envelope), KEY)).toThrow(
      "Invalid Android config envelope",
    );
  });

  it.each(["nonce", "ciphertext", "tag"])("requires canonical standard Base64 for %s", (field) => {
    for (const invalid of ["", "!!!!", " AA==", "AA==\n", "AA", "AB==", "____", "----", "AA===="])
      expect(() =>
        decodeConfigEnvelope(
          editEnvelope((value) => {
            value[field] = invalid;
          }),
          KEY,
        ),
      ).toThrow("Invalid Android config envelope");
    const unpadded = editEnvelope((value) => {
      value[field] = `${value[field] as string} `;
    });
    expect(() => decodeConfigEnvelope(unpadded, KEY)).toThrow("Invalid Android config envelope");
  });

  it.each([
    ["nonce", 11],
    ["nonce", 13],
    ["tag", 15],
    ["tag", 17],
    ["ciphertext", 1],
    ["ciphertext", MAX_CONFIG_JSON_BYTES + 1],
  ] as const)("rejects %s with an invalid decoded length of %i", (field, length) => {
    expect(() =>
      decodeConfigEnvelope(
        editEnvelope((value) => {
          value[field] = Buffer.alloc(length).toString("base64");
        }),
        KEY,
      ),
    ).toThrow("Invalid Android config envelope");
  });

  it("rejects missing Base64 padding and nonzero padding bits at otherwise valid lengths", () => {
    const noPadding = editEnvelope((value) => {
      value.tag = (value.tag as string).replace(/=+$/, "");
    });
    expect(() => decodeConfigEnvelope(noPadding, KEY)).toThrow("Invalid Android config envelope");
    const badPaddingBits = editEnvelope((value) => {
      value.tag = `${"A".repeat(21)}B==`;
    });
    expect(() => decodeConfigEnvelope(badPaddingBits, KEY)).toThrow(
      "Invalid Android config envelope",
    );
  });

  const malformedJson = ["", " ", "{", '{"secret-api-key":', '{"x":1,}', "{}junk"];
  const nonObjects = ["null", "[]", "[{}]", '"secret-api-key"', "42", "true"];
  it.each([...malformedJson, ...nonObjects])("rejects invalid config JSON (%#)", (json) => {
    expect(() => encodeConfigEnvelope(json, KEY)).toThrow("Invalid Android config JSON");
    expect(() => decodeConfigEnvelope(seal(json), KEY)).toThrow();
  });

  it.each([...malformedJson, ...nonObjects, "{}"])(
    "rejects malformed envelope JSON (%#)",
    (json) => {
      expect(() => decodeConfigEnvelope(json, KEY)).toThrow("Invalid Android config envelope");
    },
  );

  it.each([undefined, null, {}, [], 1, true, Buffer.from("{}")])(
    "rejects non-string JSON inputs (%#)",
    (input) => {
      expect(() => encodeConfigEnvelope(input as string, KEY)).toThrow(
        "Invalid Android config JSON",
      );
      expect(() => decodeConfigEnvelope(input as string, KEY)).toThrow(
        "Invalid Android config envelope",
      );
    },
  );

  it("rejects every truncated envelope prefix", () => {
    const envelope = encodeConfigEnvelope(CONFIG, KEY);
    for (let end = 0; end < envelope.length; end++) {
      expect(() => decodeConfigEnvelope(envelope.slice(0, end), KEY)).toThrow();
    }
  });

  it("enforces the config byte limit, including multibyte text", () => {
    const maximum = JSON.stringify({ x: "a".repeat(MAX_CONFIG_JSON_BYTES - 8) });
    expect(Buffer.byteLength(maximum)).toBe(MAX_CONFIG_JSON_BYTES);
    expect(decodeConfigEnvelope(encodeConfigEnvelope(maximum, KEY), KEY)).toBe(maximum);
    const tooLarge = JSON.stringify({ x: "a".repeat(MAX_CONFIG_JSON_BYTES - 7) });
    expect(() => encodeConfigEnvelope(tooLarge, KEY)).toThrow("Invalid Android config JSON");
    const multibyte = JSON.stringify({ x: "\u4e2d".repeat(Math.ceil(MAX_CONFIG_JSON_BYTES / 3)) });
    expect(multibyte.length).toBeLessThan(MAX_CONFIG_JSON_BYTES);
    expect(() => encodeConfigEnvelope(multibyte, KEY)).toThrow("Invalid Android config JSON");
  });

  it("enforces the envelope byte limit before parsing", () => {
    const envelope = encodeConfigEnvelope("{}", KEY);
    const maximum = envelope.padEnd(MAX_CONFIG_ENVELOPE_BYTES, " ");
    expect(decodeConfigEnvelope(maximum, KEY)).toBe("{}");
    expect(() => decodeConfigEnvelope(`${maximum} `, KEY)).toThrow(
      "Invalid Android config envelope",
    );
    expect(() =>
      decodeConfigEnvelope(`{${"\u4e2d".repeat(MAX_CONFIG_ENVELOPE_BYTES / 2)}`, KEY),
    ).toThrow("Invalid Android config envelope");
  });

  it("rejects invalid Unicode instead of silently replacing or dropping bytes", () => {
    expect(() => encodeConfigEnvelope('{"x":"\ud800"}', KEY)).toThrow(
      "Invalid Android config JSON",
    );
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"x":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}'),
    ]);
    expect(() => decodeConfigEnvelope(seal(invalidUtf8), KEY)).toThrow(
      "Invalid Android config JSON",
    );
    expect(() => decodeConfigEnvelope(seal(`\ufeff${CONFIG}`), KEY)).toThrow(
      "Invalid Android config JSON",
    );
    const escapedSurrogate = '{"x":"\\ud800"}';
    expect(decodeConfigEnvelope(encodeConfigEnvelope(escapedSurrogate, KEY), KEY)).toBe(
      escapedSurrogate,
    );
  });

  it("does not leak inputs, secrets, or native/JSON exceptions through errors", () => {
    const sentinel = "never-echo-this-input";
    const operations = [
      () => encodeConfigEnvelope(`{${sentinel}`, KEY),
      () => decodeConfigEnvelope(`{${sentinel}`, KEY),
      () =>
        decodeConfigEnvelope(
          editEnvelope((value) => {
            value.tag = sentinel;
          }),
          KEY,
        ),
      () => decodeConfigEnvelope(encodeConfigEnvelope(CONFIG, KEY), Buffer.alloc(32, 0x43)),
      () => decodeConfigEnvelope(seal(`{${sentinel}`), KEY),
      () => encodeConfigEnvelope(CONFIG, sentinel as unknown as Uint8Array),
    ];
    for (const operation of operations) {
      let caught: unknown;
      try {
        operation();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      for (const secret of [
        sentinel,
        "secret-api-key",
        KEY.toString("hex"),
        KEY.toString("base64"),
      ]) {
        expect(error.message).not.toContain(secret);
        expect(error.stack).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });
});
