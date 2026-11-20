import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Carry every previously published archive forward, including historical versions. */
export function preservePublishedArchives(publishedDir: string, outputDir: string): Set<string> {
  const entries = readdirSync(publishedDir, { withFileTypes: true });
  mkdirSync(outputDir, { recursive: true });
  if (realpathSync(publishedDir) === realpathSync(outputDir)) throw Error('Published archive baseline must be separate from output');
  const files = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.endsWith('.tgz')) continue;
    if (!entry.isFile()) throw Error(`Published archive is not a regular file: ${entry.name}`);
    copyFileSync(join(publishedDir, entry.name), join(outputDir, entry.name));
    files.add(entry.name);
  }
  if (!files.size) throw Error('Published archive baseline contains no archives');
  return files;
}

/** Fail publication if any retained version was removed or overwritten during the build. */
export function verifyPublishedArchives(publishedDir: string, outputDir: string, files: Set<string>): void {
  for (const file of files) {
    if (!readFileSync(join(publishedDir, file)).equals(readFileSync(join(outputDir, file)))) {
      throw Error(`Published archive changed: ${file}`);
    }
  }
}

/** Build a new release without modifying source or including generated test reports. */
export function packAddon(addonDir: string, outPath: string): void {
  const source = resolve(addonDir), output = resolve(outPath);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'addon-package-'));
  const staged = join(temporary, 'package');
  try {
    cpSync(source, staged, {
      recursive: true, verbatimSymlinks: true,
      filter(path) {
        const file = relative(source, path).replaceAll('\\', '/');
        return !['node_modules', '.tmp', 'tests/reports'].some(excluded => file === excluded || file.startsWith(`${excluded}/`));
      },
    });
    function run(command: string[]) {
      const result = Bun.spawnSync(command, { cwd: staged, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw Error(`Packing ${manifest.name} failed: ${result.stderr.toString() || result.stdout.toString()}`);
      return result.stdout.toString();
    }
    const drawio = manifest.name === '@rcarmo/piclaw-addon-drawio-editor';
    // The new Draw.io distribution installs static files directly. Previously
    // published nested-archive versions are retained by the publication build.
    const vendorFiles = ['vendor/index.html', 'vendor/js/app.min.js', 'vendor/js/PreConfig.js', 'vendor/js/PostConfig.js'];
    if (drawio) for (const file of vendorFiles) {
      const asset = statSync(join(staged, file), { throwIfNoEntry: false });
      if (!asset?.isFile() || asset.size === 0) throw Error(`Draw.io vendor is missing ${file}`);
    }
    const command = Array.isArray(manifest.files)
      ? [process.execPath, 'pm', 'pack', '--filename', output, '--ignore-scripts', '--quiet']
      : ['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', output, '-C', staged, '.'];
    run(command);
    if (drawio) {
      const entries = new Set(run(['tar', '-tzf', output]).split('\n'));
      if (entries.has('package/vendor.tar.gz') || vendorFiles.some(file => !entries.has(`package/${file}`))) {
        rmSync(output);
        throw Error('Packed Draw.io must include the loose vendor files without a nested archive');
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
