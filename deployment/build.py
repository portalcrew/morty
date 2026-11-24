"""Build a portable, checksummed release for the Morty account."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT = 'b903018a1c3d9d9a4bd68a11eb03e764'
WRANGLER = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js')]


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def run(command, cwd=ROOT, env=None):
    subprocess.run(command, cwd=cwd, env=env, check=True, timeout=1200)


def overlay(file, environment):
    result = read(file)
    result.update(result.pop('env', {}).get(environment, {}))
    for field in ('$schema', 'account_id'):
        result.pop(field, None)
    # Production Workers answer only on their custom domains, behind the zone's security and rate-limit rules.
    result.update(account_id=ACCOUNT, workers_dev=False, preview_urls=False)
    result['main'] = str(file.parent / result['main'])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('environment', choices=['production'])
    args = parser.parse_args()
    targets = read(ROOT / 'deployment/targets.json')
    assert targets['account_id'] == ACCOUNT
    environment = args.environment
    spec = targets['environments'][environment]
    release = ROOT / '.deployment-output' / environment
    # This generated directory belongs to this build; never retain artifacts from an earlier release.
    if release.exists():
        shutil.rmtree(release)
    generated = ROOT / 'node_modules/.cache/morty-deployment' / environment
    generated.mkdir(parents=True, exist_ok=True)
    morty = overlay(ROOT / 'wrangler.jsonc', environment)
    morty.update(name=spec['morty'])
    morty['compatibility_flags'] = list(dict.fromkeys(morty.get('compatibility_flags', []) + ['global_fetch_strictly_public']))
    morty['vars'] = {'APP_ORIGIN': spec['morty_origin'], 'MORTY_ALLOWED_ORIGINS': json.dumps([spec['morty_origin']])}
    morty['secrets'] = {'required': ['MORTY_SESSION_SIGNING_SECRET']}
    write(generated / 'morty.json', morty)
    # The browser compares a Computer's daemon with this release's CLI, which deploy.py requires to be npm latest.
    cli_version = read(ROOT / 'packages/cli/package.json')['version']
    env = dict(os.environ, WRANGLER_SEND_METRICS='false', MORTY_RELEASE_REVISION=os.environ.get('GITHUB_SHA', subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()))
    env.update(MORTY_WORKER_CONFIG=str(generated / 'morty.json'), MORTY_APP_ORIGIN=spec['morty_origin'], MORTY_ASSET_ORIGIN=spec['asset_origin'],
               VITE_MORTY_CLI_VERSION=cli_version)
    sentry = read(ROOT / 'deployment/sentry.json')
    sentry_release = 'morty@' + env['MORTY_RELEASE_REVISION']
    env.update(VITE_SENTRY_DSN=sentry['dsn'], VITE_SENTRY_ENVIRONMENT=environment,
               VITE_SENTRY_RELEASE=sentry_release, VITE_SENTRY_ORIGIN=spec['morty_origin'])
    # Source-map credentials belong only to the deployment job, never a PR build.
    env.pop('SENTRY_AUTH_TOKEN', None)
    env.pop('CLOUDFLARE_ENV', None)
    env.pop('CLOUDFLARE_API_TOKEN', None)
    run(['pnpm', 'exec', 'vite', 'build', '--outDir', str(release)], env=env)
    if (release / 'sourcemaps').exists():
        shutil.rmtree(release / 'sourcemaps')
    maps = sorted((release / 'client').rglob('*.js.map'))
    if not maps:
        raise ValueError('The production browser build must include source maps')
    for source_map in maps:
        script = source_map.with_suffix('')
        source = script.read_text()
        debug_ids = set(re.findall(r'sentry-dbid-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', source))
        if len(debug_ids) != 1:
            raise ValueError('Browser script must have exactly one bundler-injected debug ID')
        debug_id = next(iter(debug_ids))
        target = release / 'sourcemaps' / source_map.relative_to(release / 'client')
        target.parent.mkdir(parents=True, exist_ok=True)
        # Match Sentry's upload preparation: annotate private copies with the ID
        # already injected before chunk hashing. Never mutate public asset bytes.
        target.with_suffix('').write_text(source + '\n//# debugId=' + debug_id + '\n')
        write(target, {**read(source_map), 'debug_id': debug_id})
        source_map.unlink()
    # No source maps may remain under the Worker-served or CDN-served assets.
    if list((release / 'client').rglob('*.map')):
        raise ValueError('Public browser assets contain source maps')
    write(release / 'sentry.json', {
        'organization': sentry['organization'], 'project': sentry['project'],
        'release': sentry_release, 'environment': environment,
    })
    morty_dir = release / spec['morty'].replace('-', '_')
    built = read(morty_dir / 'wrangler.json')
    allowed = ['name', 'main', 'account_id', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'version_metadata', 'migrations', 'r2_buckets', 'vars', 'assets', 'observability', 'ratelimits', 'workers_dev', 'preview_urls', 'secrets', 'placement', 'limits', 'rules', 'triggers']
    portable = {key: built[key] for key in allowed if key in built}
    portable.update(no_bundle=True, find_additional_modules=True)
    write(morty_dir / 'wrangler.json', portable)
    assert portable['account_id'] == ACCOUNT and portable['name'] == spec['morty'] and not portable.get('routes')
    configs = {'morty': morty_dir.relative_to(release).as_posix() + '/wrangler.json'}
    # Artifact files contain public configuration and compiled code only; secrets are supplied at deploy time.
    cli_release = None
    if os.environ.get('MORTY_CLI_RELEASE_MANIFEST'):
        cli_release = read(ROOT / os.environ['MORTY_CLI_RELEASE_MANIFEST'])
        if cli_release['revision'] != env['MORTY_RELEASE_REVISION'] or cli_release['version'] != cli_version:
            raise ValueError('Cloud and CLI release identities differ')
    files = {p.relative_to(release).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(release.rglob('*')) if p.is_file() and p.name != 'release.json'}
    write(release / 'release.json', {'format': 'morty-cloud-release-v3', 'account_id': ACCOUNT, 'environment': environment, 'revision': env['MORTY_RELEASE_REVISION'], 'cliVersion': cli_version, 'cliRelease': cli_release, 'configs': configs, 'target': spec, 'files': files, 'reportsDeployedVersion': True})
    print(json.dumps({'release': str(release), 'environment': environment, 'files': len(files)}))


if __name__ == '__main__':
    main()
