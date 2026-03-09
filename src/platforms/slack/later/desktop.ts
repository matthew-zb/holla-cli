/**
 * macOS-only: reads browser credentials from the Slack desktop app.
 * - xoxd: decrypts from ~/Library/Application Support/Slack/Cookies (SQLite)
 * - xoxc: extracts from LevelDB local storage, with Snappy decompression for SST files
 *
 * Each workspace's xoxc is stored alongside its domain name in the JSON data.
 * We find the right xoxc by looking for ("domain":"<workspace>") near the token.
 */
import { Database } from "bun:sqlite";
import { readdirSync, copyFileSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { execSync, execFileSync } from "child_process";

const SLACK_APP_DIR = join(homedir(), "Library", "Application Support", "Slack");
const COOKIES_DB = join(SLACK_APP_DIR, "Cookies");
const LOCAL_STORAGE_DIR = join(SLACK_APP_DIR, "Local Storage", "leveldb");

// ---------------------------------------------------------------------------
// xoxd: decrypt from Slack Cookies SQLite
// ---------------------------------------------------------------------------

async function decryptSlackCookie(encryptedValue: Uint8Array): Promise<string> {
  const safeStorageKey = execSync('security find-generic-password -s "Slack Safe Storage" -w').toString().trim();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(safeStorageKey),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-1",
      salt: new TextEncoder().encode("saltysalt"),
      iterations: 1003,
    },
    keyMaterial,
    128,
  );

  const derivedKey = await crypto.subtle.importKey(
    "raw",
    derivedBits,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  const ciphertext = encryptedValue.slice(3); // skip "v10" prefix
  const iv = new Uint8Array(16).fill(0x20); // 16 space chars

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    derivedKey,
    ciphertext,
  );

  const text = new TextDecoder("utf-8", { fatal: false }).decode(decrypted);
  const match = text.match(/xoxd-[A-Za-z0-9%_.~-]+/);
  if (!match) throw new Error("xoxd token not found in decrypted cookie");
  return match[0];
}

async function readXoxdFromSlackApp(): Promise<string> {
  const tmpDb = join(tmpdir(), `slack-cookies-${Date.now()}.db`);
  copyFileSync(COOKIES_DB, tmpDb);
  try {
    const db = new Database(tmpDb, { readonly: true });
    const row = db
      .query("SELECT encrypted_value FROM cookies WHERE name = 'd' AND host_key = '.slack.com' LIMIT 1")
      .get() as { encrypted_value: Uint8Array } | null;
    db.close();
    if (!row) throw new Error("Slack 'd' cookie not found");
    return await decryptSlackCookie(row.encrypted_value);
  } finally {
    try { unlinkSync(tmpDb); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// xoxc: parse LevelDB (with Snappy decompression for SST files)
// ---------------------------------------------------------------------------

/**
 * Python snippet that parses a LevelDB SST file with Snappy decompression
 * and returns JSON: [{ domain, xoxc }, ...]
 */
const PYTHON_SST_PARSER = `
import sys, json, struct, re
try:
    import snappy
    HAS_SNAPPY = True
except ImportError:
    HAS_SNAPPY = False

def read_varint(data, pos):
    result, shift = 0, 0
    while True:
        b = data[pos]; pos += 1
        result |= (b & 0x7f) << shift
        if not (b & 0x80): break
        shift += 7
    return result, pos

def extract_tokens(raw):
    text = raw.decode('utf-8', errors='replace')
    results = []
    for m in re.finditer(r'xoxc-[0-9a-f-]{40,}', text):
        token = m.group()
        # look for domain context within 1000 chars before the token
        start = max(0, m.start() - 1000)
        ctx = text[start:m.start()]
        dm = re.search(r'"domain"\\s*:\\s*"([^"]+)"', ctx)
        if dm:
            results.append({'domain': dm.group(1), 'xoxc': token})
        else:
            results.append({'domain': None, 'xoxc': token})
    return results

path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()

results = []

# Check magic
if data[-8:] != b'\\x57\\xfb\\x80\\x8b\\x24\\x75\\x47\\xdb':
    # Not a valid SST file or it's a log file - raw scan
    results.extend(extract_tokens(data))
    print(json.dumps(results))
    sys.exit(0)

# Parse SST footer
footer = data[-48:]
pos = 0
meta_offset, pos = read_varint(footer, pos)
meta_size, pos = read_varint(footer, pos)
idx_offset, pos = read_varint(footer, pos)
idx_size, pos = read_varint(footer, pos)

# Read index block
blk_data = data[idx_offset:idx_offset+idx_size]
blk_type = data[idx_offset+idx_size] if idx_offset+idx_size < len(data) else 0

if blk_type == 1 and HAS_SNAPPY:
    try: blk_data = snappy.decompress(blk_data)
    except: pass

# Parse index entries to find data blocks
restarts_size = struct.unpack_from('<I', blk_data, len(blk_data)-4)[0] if len(blk_data) >= 4 else 0
num_restarts = min(restarts_size, 1000)
block_handles = []
pos = 0
last_key = b''
limit = len(blk_data) - (num_restarts + 1) * 4 - 4

while pos < limit:
    try:
        shared, pos = read_varint(blk_data, pos)
        non_shared, pos = read_varint(blk_data, pos)
        val_len, pos = read_varint(blk_data, pos)
        pos += non_shared
        value = blk_data[pos:pos+val_len]; pos += val_len
        vpos = 0
        blk_offset, vpos = read_varint(value, vpos)
        blk_size, _ = read_varint(value, vpos)
        block_handles.append((blk_offset, blk_size))
    except: break

for blk_offset, blk_size in block_handles:
    raw = data[blk_offset:blk_offset+blk_size]
    typ = data[blk_offset+blk_size] if blk_offset+blk_size < len(data) else 0
    if typ == 1 and HAS_SNAPPY:
        try: raw = snappy.decompress(raw)
        except: pass
    if b'xoxc-' in raw:
        results.extend(extract_tokens(raw))

print(json.dumps(results))
`;

function readAllXoxcFromLevelDB(): Map<string, string> {
  // Returns a map of domain → xoxc (most recent win)
  const domainTokens = new Map<string, string>();

  try {
    const files = readdirSync(LOCAL_STORAGE_DIR)
      .filter((f) => f.endsWith(".ldb") || f.endsWith(".log"))
      .sort(); // ascending = oldest first, newer files overwrite

    for (const file of files) {
      const filePath = join(LOCAL_STORAGE_DIR, file);
      try {
        const result = execFileSync("python3", ["-c", PYTHON_SST_PARSER, filePath], {
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const entries = JSON.parse(result.toString()) as Array<{ domain: string | null; xoxc: string }>;
        for (const entry of entries) {
          if (entry.domain) {
            domainTokens.set(entry.domain, entry.xoxc);
          } else if (!domainTokens.has("__unknown__")) {
            domainTokens.set("__unknown__", entry.xoxc);
          }
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore */ }

  return domainTokens;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns { xoxc, xoxd } for the given workspace domain, or null if unavailable.
 * Only works on macOS with the Slack desktop app installed.
 */
export async function readSlackDesktopCredentials(domain?: string): Promise<
  { xoxc: string; xoxd: string } | null
> {
  if (process.platform !== "darwin") return null;

  try {
    const [xoxd, tokenMap] = await Promise.all([
      readXoxdFromSlackApp(),
      Promise.resolve(readAllXoxcFromLevelDB()),
    ]);

    let xoxc: string | undefined;
    if (domain) {
      xoxc = tokenMap.get(domain) ?? tokenMap.get("__unknown__");
    } else {
      // No domain specified — return the most recently active token
      xoxc = [...tokenMap.values()].at(-1);
    }

    if (!xoxd || !xoxc) return null;
    return { xoxc, xoxd };
  } catch {
    return null;
  }
}
