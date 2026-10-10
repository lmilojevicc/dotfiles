#!/usr/bin/env bash
# Builds and installs tooling ONLY in TEMP; never launches Pi or reads a live policy.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT=${1:-"$ROOT/benchmarks/results/latest.json"}
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/pi-redaction-benchmark.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/upstream" "$TEMP/home"
touch "$TEMP/empty-user.npmrc" "$TEMP/empty-global.npmrc"
export NPM_CONFIG_USERCONFIG="$TEMP/empty-user.npmrc" NPM_CONFIG_GLOBALCONFIG="$TEMP/empty-global.npmrc"
# HOME is overridden for the measured Node process below, not Cargo/toolchain lookup.
python3 - "$ROOT" "$TEMP" <<'PY'
import sys,shutil,pathlib
shutil.copytree(sys.argv[1], pathlib.Path(sys.argv[2])/'local', ignore=shutil.ignore_patterns('target','*.node','node_modules','results'))
PY
export BENCH_TEMP="$TEMP"
python3 - <<'PY'
import os,time,subprocess,json,pathlib
p=pathlib.Path(os.environ['BENCH_TEMP']); measurements={}
def run(name,args,cwd=None):
 start=time.perf_counter();subprocess.run(args,check=True,cwd=cwd);measurements[name]=(time.perf_counter()-start)*1000
run('sourceAcquisitionMs',['curl','-fsSL','https://api.github.com/repos/steimerbyte/pi-redact-all/tarball/a1a189f970f53c81f90c8de587c59c72cefec5ee','-o',str(p/'comparator.tar.gz')])
run('sourceExtractionMs',['tar','-xzf',str(p/'comparator.tar.gz'),'-C',str(p/'upstream'),'--strip-components=1'])
run('temporaryToolingInstallMs',['npm','install','--prefix',str(p/'tooling'),'--cache',str(p/'cache'),'--ignore-scripts','--no-audit','--no-fund','typescript@5.9.3','@types/node@22.20.0'])
(p/'upstream'/'node_modules').symlink_to(p/'tooling'/'node_modules',target_is_directory=True)
run('comparatorCompileMs',[str(p/'tooling'/'node_modules'/'.bin'/'tsc'),'-p',str(p/'upstream'/'tsconfig.build.json')])
run('localAddonBuildMs',['node',str(p/'local'/'scripts'/'build-native.mjs')])
host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
run('rustBenchmarkBuildMs',['cargo','build','--locked','--release','--manifest-path',str(p/'local'/'benchmarks'/'core'/'Cargo.toml'),'--target-dir',str(p/'target'),'--target',host])
# Node runner has one platform-independent executable location.
exe=p/'target'/host/'release'/'pi-redaction-corpus-benchmark'
(p/'target'/'release').mkdir(exist_ok=True);shutil_exe=p/'target'/'release'/'pi-redaction-corpus-benchmark'
shutil_exe.symlink_to(exe)
(p/'setup.json').write_text(json.dumps({'durationsMs':measurements,'toolchain':{'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'cargo':subprocess.check_output(['cargo','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip(),'typescript':'5.9.3','nodeTypes':'22.20.0'},'note':'One fresh build/temporary npm cache, shared machine Cargo registry cache may be warm; not hot-scan latency.'}))
PY
HOME="$TEMP/home" node --experimental-strip-types "$TEMP/local/benchmarks/run.mjs" "$TEMP" "$OUTPUT"
