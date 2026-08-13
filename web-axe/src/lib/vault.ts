/**
 * 볼트 — sync 페이로드 수신, 키 언랩, 목록 인덱스 구축, 비밀 값 지연 복호.
 *
 * 크립토는 전부 PureCrypto 다. 이 파일은 필드 매핑과 키 라우팅(개인키 vs org 키 vs 항목키)만 한다.
 *
 * 설계 원칙 — 평문을 메모리에 오래 두지 않는다:
 *  · 목록/검색에 필요한 것(이름·계정·URI·폴더/컬렉션 이름)만 미리 푼다.
 *  · 비밀번호·TOTP 시드·노트는 항목을 열 때(또는 복사할 때)만 푼다 (revealItem).
 *  · 잠금은 base 키만 zeroize 하면 나머지 전부가 다시 못 풀리는 암호문으로 되돌아간다.
 */
import { PureCrypto, type Kdf } from "../sdk.ts";
import { apiGet, pick } from "./api.ts";

/** 잠금 시 폐기할 대칭키 묶음. 이게 사라지면 rawSync 는 못 푸는 암호문 덩어리가 된다. */
export interface VaultKeys {
  userKey: Uint8Array;
  orgKeys: Map<string, Uint8Array>;
}

export interface VaultItem {
  id: string;
  /** Bitwarden CipherType: 1 로그인 · 2 보안 노트 · 3 카드 · 4 신원 */
  type: number;
  name: string;
  username?: string;
  uris: string[];
  folderId: string | null;
  collectionIds: string[];
  organizationId: string | null;
  favorite: boolean;
  /** 마스터패스워드 재확인 항목 — P1 은 배지로 표시만 한다. */
  reprompt: boolean;
  /** 지연 복호용 암호문. 목록/검색은 이 값을 건드리지 않는다. */
  enc: { key?: string; password?: string; totp?: string; notes?: string };
  /** 소문자 검색 대상 (이름·계정·URI). */
  haystack: string;
  /** 항목 단위 복호 실패 (org 키 없음 등) — 목록에 사유를 노출한다. */
  error?: string;
}

export interface NamedRef {
  id: string;
  name: string;
  organizationId?: string | null;
}

export interface VaultData {
  items: VaultItem[];
  folders: NamedRef[];
  collections: NamedRef[];
  organizations: NamedRef[];
  totalCiphers: number;
  failed: number;
}

export const CIPHER_TYPE_LABEL: Record<number, string> = {
  1: "로그인",
  2: "보안 노트",
  3: "카드",
  4: "신원",
};

/** 서버에서 sync 원문을 받는다. 이 시점의 값은 전부 암호문이므로 잠금 상태에도 들고 있어도 된다. */
export async function fetchSync(token: string): Promise<Record<string, unknown>> {
  return (await apiGet("/sync?excludeDomains=true", token)) as Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/**
 * 마스터패스워드로 유저키를 풀고, 개인키를 거쳐 조직 키까지 얻는다.
 * 개인키(RSA)는 org 키 decapsulate 에만 쓰이므로 즉시 zeroize 한다.
 */
export function unlockKeys(sync: Record<string, unknown>, email: string, password: string, kdf: Kdf): VaultKeys {
  const profile = asRecord(pick(sync, "profile", "Profile"));
  const encUserKey = pick<string>(profile, "key", "Key");
  if (!encUserKey) throw new Error("sync 응답에 profile.key(마스터키로 감싼 유저키)가 없다");

  const userKey = PureCrypto.decrypt_user_key_with_master_password(encUserKey, password, email, kdf);

  const orgKeys = new Map<string, Uint8Array>();
  const encPrivateKey = pick<string>(profile, "privateKey", "PrivateKey");
  const orgs = asArray(pick(profile, "organizations", "Organizations"));
  if (encPrivateKey && orgs.length) {
    const privateKey = PureCrypto.unwrap_decapsulation_key(encPrivateKey, userKey);
    try {
      for (const org of orgs) {
        const id = pick<string>(org, "id", "Id");
        const key = pick<string>(org, "key", "Key");
        if (!id || !key) continue;
        try {
          orgKeys.set(id, PureCrypto.decapsulate_key_unsigned(key, privateKey));
        } catch {
          // 이 조직만 건너뛴다 — 해당 조직 항목이 목록에서 개별 에러로 표시된다.
        }
      }
    } finally {
      privateKey.fill(0);
    }
  }
  return { userKey, orgKeys };
}

/** 잠금·로그아웃에서 부른다. 이후 rawSync 는 복호 불가능한 암호문으로 남는다. */
export function wipeKeys(keys: VaultKeys | null): void {
  if (!keys) return;
  keys.userKey.fill(0);
  for (const k of keys.orgKeys.values()) k.fill(0);
  keys.orgKeys.clear();
}

/** 항목 필드를 푸는 대칭키. 항목 자체 키가 있으면 base 키로 언랩해 그걸 쓴다 (신형 아이템). */
function itemKey(item: Pick<VaultItem, "organizationId" | "enc">, keys: VaultKeys): { key: Uint8Array; owned: boolean } {
  const base = item.organizationId ? keys.orgKeys.get(item.organizationId) : keys.userKey;
  if (!base) throw new Error(`조직 키가 없다 (${item.organizationId})`);
  if (!item.enc.key) return { key: base, owned: false };
  return { key: PureCrypto.unwrap_symmetric_key(item.enc.key, base), owned: true };
}

const decStr = (value: string | undefined, key: Uint8Array): string | undefined =>
  value ? PureCrypto.symmetric_decrypt_string(value, key) : undefined;

function decryptNames(rows: Record<string, unknown>[], keyFor: (row: Record<string, unknown>) => Uint8Array | undefined): NamedRef[] {
  const out: NamedRef[] = [];
  for (const row of rows) {
    const id = pick<string>(row, "id", "Id");
    if (!id) continue;
    const key = keyFor(row);
    const encName = pick<string>(row, "name", "Name");
    let name = "(이름 복호 실패)";
    if (key) {
      try {
        name = decStr(encName, key) ?? "(이름 없음)";
      } catch {
        /* 이름만 실패 — 항목 자체는 계속 보여 준다 */
      }
    }
    out.push({ id, name, organizationId: pick<string>(row, "organizationId", "OrganizationId") ?? null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/**
 * 목록·검색에 필요한 최소 필드만 복호해 인덱스를 만든다.
 * 비밀번호·TOTP·노트는 여기서 풀지 않는다 (revealItem 참조).
 */
export function buildIndex(sync: Record<string, unknown>, keys: VaultKeys): VaultData {
  const profile = asRecord(pick(sync, "profile", "Profile"));
  const organizations: NamedRef[] = asArray(pick(profile, "organizations", "Organizations"))
    .map((o) => ({ id: pick<string>(o, "id", "Id") ?? "", name: pick<string>(o, "name", "Name") ?? "(조직)" }))
    .filter((o) => o.id);

  const folders = decryptNames(asArray(pick(sync, "folders", "Folders")), () => keys.userKey);
  const collections = decryptNames(asArray(pick(sync, "collections", "Collections")), (row) => {
    const orgId = pick<string>(row, "organizationId", "OrganizationId");
    return orgId ? keys.orgKeys.get(orgId) : keys.userKey;
  });

  const ciphers = asArray(pick(sync, "ciphers", "Ciphers"));
  const items: VaultItem[] = [];
  let failed = 0;

  for (const c of ciphers) {
    const id = pick<string>(c, "id", "Id");
    if (!id) continue;
    // 휴지통 항목은 목록에서 제외한다 (스톡 볼트와 동일).
    if (pick(c, "deletedDate", "DeletedDate")) continue;

    const organizationId = pick<string>(c, "organizationId", "OrganizationId") ?? null;
    const login = asRecord(pick(c, "login", "Login"));
    const base: VaultItem = {
      id,
      type: Number(pick<number>(c, "type", "Type") ?? 1),
      name: "(복호 실패)",
      uris: [],
      folderId: pick<string>(c, "folderId", "FolderId") ?? null,
      collectionIds: (pick<string[]>(c, "collectionIds", "CollectionIds") ?? []).filter(Boolean),
      organizationId,
      favorite: !!pick(c, "favorite", "Favorite"),
      reprompt: Number(pick<number>(c, "reprompt", "Reprompt") ?? 0) !== 0,
      enc: {
        key: pick<string>(c, "key", "Key"),
        password: pick<string>(login, "password", "Password"),
        totp: pick<string>(login, "totp", "Totp"),
        notes: pick<string>(c, "notes", "Notes"),
      },
      haystack: "",
    };

    let resolved: { key: Uint8Array; owned: boolean } | null = null;
    try {
      resolved = itemKey(base, keys);
      const k = resolved.key;
      base.name = decStr(pick<string>(c, "name", "Name"), k) ?? "(이름 없음)";
      base.username = decStr(pick<string>(login, "username", "Username"), k);

      const uriRows = asArray(pick(login, "uris", "Uris"));
      for (const u of uriRows) {
        const uri = decStr(pick<string>(u, "uri", "Uri"), k);
        if (uri) base.uris.push(uri);
      }
      if (!base.uris.length) {
        const legacy = decStr(pick<string>(login, "uri", "Uri"), k);
        if (legacy) base.uris.push(legacy);
      }
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
      failed++;
    } finally {
      if (resolved?.owned) resolved.key.fill(0);
    }

    base.haystack = [base.name, base.username ?? "", ...base.uris].join("\n").toLowerCase();
    items.push(base);
  }

  items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, "ko"));
  return { items, folders, collections, organizations, totalCiphers: ciphers.length, failed };
}

export type SecretField = "password" | "totp" | "notes";

export type RevealedItem = Partial<Record<SecretField, string>>;

/**
 * 항목의 비밀 값을 그때그때 푼다. **요청한 필드만** 푼다 — 항목을 열었다는 이유로 비밀번호까지
 * 평문으로 만들지 않기 위해서다 (상세 패널은 notes·totp 만 열고, password 는 보기/복사 순간에
 * 따로 요청한다). 호출부는 결과를 오래 들고 있지 않는다.
 */
export function revealItem(item: VaultItem, keys: VaultKeys, fields: SecretField[]): RevealedItem {
  const wanted = fields.filter((f) => item.enc[f]);
  if (!wanted.length) return {};
  const resolved = itemKey(item, keys);
  try {
    const out: RevealedItem = {};
    for (const f of wanted) out[f] = decStr(item.enc[f], resolved.key);
    return out;
  } finally {
    if (resolved.owned) resolved.key.fill(0);
  }
}
