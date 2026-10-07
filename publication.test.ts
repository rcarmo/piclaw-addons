import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = (name: string): any => Bun.YAML.parse(readFileSync(new URL(`.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const build = workflow('build');
const steps = build.jobs.build.steps;
const step = (name: string) => steps.find((value: any) => value.name === name);
const condition = "success() && github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";

// Evaluate the exact small Actions expressions used by these workflows.
function evaluate(expression: string, context: Record<string, unknown>) {
  const replaced = expression.replace(/\b(?:github\.[\w.]+|success\(\))\b|success\(\)/g, key => JSON.stringify(context[key] ?? null));
  if (/[^\s\w.'"=!&|():/\-]/.test(replaced)) throw Error('Unexpected workflow condition');
  return Boolean(Function(`return (${replaced})`)());
}

test('only superseded checks for the same PR can cancel an active run', () => {
  expect(build.concurrency).toEqual({
    group: "addons-${{ github.event.pull_request.number || 'publication' }}",
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  // These cases model the exact expressions asserted above, not an Actions scheduler.
  const lane = (event: string, pr?: number) => ({
    group: `addons-${pr || 'publication'}`,
    cancel: event === 'pull_request',
  });
  expect(lane('pull_request', 10)).toEqual(lane('pull_request', 10));
  expect(lane('pull_request', 10).group).not.toBe(lane('pull_request', 11).group);
  expect(lane('pull_request', 10).group).not.toBe(lane('push').group);
  expect(lane('pull_request', 10).cancel).toBe(true);
  expect(lane('push').cancel).toBe(false);
  expect(lane('workflow_dispatch').cancel).toBe(false);
  expect(lane('push').group).toBe(lane('workflow_dispatch').group);
  // The caller owns the lane. Reusing it inside a called workflow can cancel itself.
  expect(workflow('validate-metadata').concurrency).toBeUndefined();
  const publish = workflow('publish');
  expect(publish.concurrency).toEqual({ group: 'publish', 'cancel-in-progress': false });
  expect(publish.concurrency.group).not.toBe(lane('push').group);
});

test('same-source reusable validation is required and includes every existing validation job', () => {
  expect(build.jobs.validation.uses).toBe('./.github/workflows/validate-metadata.yml');
  expect(build.jobs.build.needs).toBe('validation');
  const validation = workflow('validate-metadata');
  expect(Object.keys(validation.on)).toEqual(['workflow_call']);
  expect(Object.keys(validation.jobs)).toEqual(['validate', 'late-night-regrets', 'code-review']);
  for (const job of Object.values(validation.jobs) as any[]) {
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.if).toBeUndefined();
  }
  expect(Object.keys(build.on)).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  expect(build.on.push.branches).toEqual(['main']);
  expect(build.on.push.paths).toBeUndefined();
  expect(build.on.pull_request).toBeNull();
});

test('all publication steps require success and main, never always or continue-on-error', () => {
  for (const name of ['Require completed publication gates', 'Build site and package tarballs', 'Copy assets into docs', 'Deploy to GitHub Pages']) {
    expect(step(name).if).toBe(condition);
    expect(step(name)['continue-on-error']).toBeUndefined();
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      for (const success of [true, false]) {
        for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
          expect(evaluate(step(name).if, { 'success()': success, 'github.event_name': event, 'github.ref': ref }))
            .toBe(success && event !== 'pull_request' && ref === 'refs/heads/main');
        }
      }
    }
  }
});

test('required gate shell rejects failed, cancelled, missing and skipped required UX', () => {
  const gate = step('Require completed publication gates');
  expect(gate.env).toEqual({ CATALOG_OUTCOME: '${{ steps.catalog.outcome }}', UX_REQUIRED: '${{ steps.addon_tests.outputs.present }}', UX_OUTCOME: '${{ steps.ux.outcome }}' });
  expect(step('Validate catalog and publication contracts').id).toBe('catalog');
  expect(step('Run add-on UX tests').id).toBe('ux');
  expect(step('Run add-on UX tests').if).toBe("steps.addon_tests.outputs.present == 'true'");
  for (const catalog of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const required of ['true', 'false', '']) {
      for (const ux of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const result = Bun.spawnSync(['bash', '-e', '-c', gate.run], { env: { PATH: process.env.PATH!, CATALOG_OUTCOME: catalog, UX_REQUIRED: required, UX_OUTCOME: ux }, stdout: 'pipe', stderr: 'pipe' });
        expect(result.exitCode === 0).toBe(catalog === 'success' && (required === 'true' && ux === 'success' || required === 'false' && ux === 'skipped'));
      }
    }
  }
});

test('source identity is checked and published; UX uses an immutable released core', () => {
  expect(step('Record validated source').run).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  expect(step('Copy assets into docs').run).toContain('cp publication-source.txt docs/publication-source.txt');
  expect(step('Checkout Piclaw runtime for add-on UX tests').with.ref).toBe('e4c2b9a3536eb64361da86237a4dfc970d772682');
  expect(steps[0].with?.ref).toBeUndefined(); // Default checkout is the triggering source, not moving main.
  expect(steps[0].with['fetch-depth']).toBe(0); // Catalog dates require full add-on history.
  expect(step('Validate catalog and publication contracts').run).toContain('bun run check:catalog');
  expect(step('Validate catalog and publication contracts').run).toContain('bun test publication.test.ts');
});

test('failure diagnostics and fixture cleanup survive failed UX without publishing', () => {
  expect(step('Upload failure diagnostics').if).toBe('failure() || cancelled()');
  expect(step('Upload failure diagnostics').with.path).toContain('publication-source.txt');
  expect(step('Upload add-on UX reports').if).toStartWith('always()');
  expect(step('Stop Piclaw add-on UX test instance').if).toStartWith('always()');
});

test('archival publication only follows successful same-repository main validation at its exact SHA', () => {
  const publish = workflow('publish');
  expect(Object.keys(publish.on)).toEqual(['workflow_run']);
  expect(publish.on.workflow_run).toEqual({ workflows: ['Build & deploy docs + tarballs'], types: ['completed'], branches: ['main'] });
  const job = publish.jobs.publish;
  for (const conclusion of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      for (const branch of ['main', 'feature']) {
        for (const repo of ['rcarmo/piclaw-addons', 'fork/piclaw-addons']) {
          expect(evaluate(job.if, { 'github.event.workflow_run.conclusion': conclusion, 'github.event.workflow_run.head_branch': branch, 'github.event.workflow_run.event': event, 'github.event.workflow_run.head_repository.full_name': repo, 'github.repository': 'rcarmo/piclaw-addons' }))
            .toBe(conclusion === 'success' && event !== 'pull_request' && branch === 'main' && repo === 'rcarmo/piclaw-addons');
        }
      }
    }
  }
  expect(job.steps[0].with.ref).toBe('${{ github.event.workflow_run.head_sha }}');
  expect(job.steps.find((s: any) => s.name === 'Verify validated source').run).toContain('test "$(git rev-parse HEAD)" = "$VALIDATED_SHA"');
  expect(job.steps.find((s: any) => s.name === 'Publish version-bumped addons').run).toContain('set -euo pipefail');
});
