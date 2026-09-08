import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
const MAGIC = "piclaw disposable iroh fixture";
function validToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{48}$/.test(value);
}
export function requireOwnedFixtureRoot(
  value: string | undefined,
  prefix: string,
  token: string | undefined,
) {
  if (!value || !validToken(token))
    throw new Error("Owned temporary root and token required.");
  const path = resolve(value),
    tmp = realpathSync("/tmp");
  if (path === tmp || !path.startsWith(tmp + sep))
    throw new Error("Fixture root is outside canonical /tmp.");
  const relative = path.slice(tmp.length + 1),
    first = relative.split(sep)[0];
  if (!first?.startsWith(prefix))
    throw new Error("Fixture root is outside the allowed temporary prefix.");
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path
  )
    throw new Error("Fixture root must be a real directory.");
  let current = path;
  while (current !== tmp) {
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Fixture root has a symlink ancestor.");
    const parent = resolve(current, "..");
    if (parent === current || !parent.startsWith(tmp))
      throw new Error("Fixture ancestry escaped canonical /tmp.");
    current = parent;
  }
  const markerPath = join(path, ".piclaw-iroh-fixture");
  let marker: any = null;
  try {
    const s = lstatSync(markerPath);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error();
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {}
  if (marker?.magic !== MAGIC || marker?.token !== token)
    throw new Error("Fixture ownership marker/token mismatch.");
  return path;
}
export function createFixtureMarker(
  path: string,
  token = randomBytes(24).toString("hex"),
) {
  if (!validToken(token)) throw new Error("Invalid fixture token.");
  writeFileSync(
    join(path, ".piclaw-iroh-fixture"),
    JSON.stringify({ magic: MAGIC, token }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return token;
}
export function writeEvidence(root: string, name: string, data: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name))
    throw new Error("Invalid evidence name.");
  const target = join(root, name);
  if (existsSync(target)) throw new Error("Evidence already exists: " + name);
  writeFileSync(target, data, { flag: "wx", mode: 0o600 });
}
export function copyEvidence(source: string, target: string) {
  const s = lstatSync(source);
  if (!s.isFile() || s.isSymbolicLink())
    throw new Error("Evidence source must be a regular file.");
  copyFileSync(source, target, constants.COPYFILE_EXCL);
}
