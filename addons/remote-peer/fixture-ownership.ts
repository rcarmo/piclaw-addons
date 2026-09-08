import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
const MAGIC = "piclaw disposable iroh fixture";
export function requireOwnedFixtureRoot(
  value: string | undefined,
  prefix: string,
) {
  if (!value) throw new Error("Owned temporary root required.");
  const path = resolve(value),
    tmp = realpathSync("/tmp");
  const relative = path.slice(tmp.length + 1);
  const first = relative.split(sep)[0];
  if (!first?.startsWith(prefix) || path === tmp)
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
    current = resolve(current, "..");
  }
  let marker = "";
  try {
    marker = readFileSync(join(path, ".piclaw-iroh-fixture"), "utf8").trim();
  } catch {}
  if (marker !== MAGIC) throw new Error("Fixture ownership marker missing.");
  return path;
}
export function createFixtureMarker(path: string) {
  writeFileSync(join(path, ".piclaw-iroh-fixture"), MAGIC + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
export function writeEvidence(root: string, name: string, data: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name))
    throw new Error("Invalid evidence name.");
  const target = join(root, name);
  if (existsSync(target)) throw new Error("Evidence already exists: " + name);
  writeFileSync(target, data, { flag: "wx", mode: 0o600 });
}
