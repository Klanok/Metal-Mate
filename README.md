# Metal Mate

Desktop 3D sheet metal modeller: design folded parts, unfold them to accurate
flat patterns, and export DXF for the laser. First real workload is stainless
steel benchtops — folded edges on any side, integral splashbacks, sink and hob
cutouts.

The design is a **generic sheet metal core with domain template packs on top**.
The core knows about faces, bends, allowances and press brakes; it does not know
what a benchtop is. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full design, and [`CLAUDE.md`](CLAUDE.md) for the invariants any change has to
respect.

## Status

The domain core and the desktop shell are both built. 272 tests pass, plus
26 browser tests against the built bundle.

**Working today** (`core/`, 221 tests):

| Area | State |
|---|---|
| Face-bend graph + structural checks | tree invariant, bend-line direction convention, orientation |
| Feature model and regeneration | base flange, edge flange (insets, mitres, multi-fold chains), cutouts, corner joints |
| Topological naming | features address geometry as `top.front`, `frontDrop.tip` |
| Unfold engine | bend allowance placement, cutouts, overlap and island detection |
| Folded 3D view | face frames and bend arcs, fold fraction 0..1 for the animation |
| Materials and bend tables | 304/316, aluminium, Zincalume, mild steel; calibration back-solve from a measured test strip |
| Machine profile | bed, tonnage, die rack, throat, open height, thickness limits; editable in the app, structurally checked, and flagged as a placeholder until confirmed |
| Validation | 14 rules, each with a passing and a failing fixture; errors block export |
| Canopy template | skeleton: six flat panels cut to the neutral-surface box, placed as an assembly tree, exported as a document |
| Benchtop template | an edge on any of the four sides (square drop / drop-and-return / boxed / upstand), corners that close and weld (45° mitred returns) or relieve, sink, hob and tap cutouts |
| DXF R12 export | arcs as bulges, layer mapping via export profiles, golden-file tested |
| DXF import | reader plus healing (chains loose lines and arcs into closed loops) |
| Part placement | edge mates position parts relative to each other, as a tree over parts, so cross-part joints have somewhere to meet |
| Corner joints | weld gap and tab-and-slot, recorded alongside the tree and applied to the 2D profiles at unfold time |
| Multi-part documents | several parts in one document, each keyed by name or part number, with quantities, a cut-list rollup and all-or-nothing export |
| Project files | JSON payload, schema version, migration seam |

**The app** (`app/`, Tauri 2 + React + Three.js, 51 unit + 26 browser tests):

| Area | State |
|---|---|
| Two templates | benchtop and canopy wizards; the form swaps with the design you select |
| Benchtop wizard | every template parameter, live; cutouts added and edited in place |
| 3D viewport | folded solid with a fold slider from flat to folded, orbit camera |
| Flat preview | SVG with real arc commands, on the DXF layer colours |
| Validation panel | full report, and it says the machine is a placeholder |
| Feature tree and bend table | what the template generated, and where each allowance came from |
| Export | DXF button disabled while errors stand; `exportDxf` re-checks anyway |
| Designs and parts | designs you edit, the parts each one makes underneath; per-part status; total pieces, mass and cut length |
| Shop settings | press brake editor, and bend calibration that back-solves K from a folded test strip |
| Save / open | `.smp` project files through native dialogs; the machine and bend tables travel with the part |

The frontend is verified in a real browser: it loads, builds the default
benchtop, renders both views, blocks export when a 3000 mm benchtop overruns
the 2500 mm bed, and reports a bad parameter instead of white-screening. The
Rust shell compiles (`cargo check`), which also validates `tauri.conf.json` and
the capability files, but the **packaged desktop binary has not been run** — no
display in the build environment. `npm run tauri dev` is the first thing to try
on a real machine.

**Not built yet:** PDF drawing output, hems, the sketcher, direct feature-tree
editing, and nesting.

The canopy template is a **skeleton**: flat panels, butt-welded square corners,
no window apertures, no tapers, no tabs, no lips. It is drivable from the app —
add a canopy, size it, pick a panel — but it is not yet a canopy anybody would
build. Corner joints and part placement are in the core but not surfaced in the
UI, and joints still resolve inside one part, so the canopy's twelve seams are
butt joints with no weld gap. DXF import is in the core but not surfaced
either.

**Not yet verified against reality**, and this matters before anyone cuts metal:

- The press brake ships as a **placeholder**. Settings → Press brake replaces
  it, and the tick that clears the placeholder flag is deliberately a person's
  job: until someone has checked the bed, the tonnage chart and the die rack
  against the machine on the floor, every tonnage and minimum-flange result is
  an estimate and the report says so on every part.
- The DXF writer has not been checked against the fabricator's CAM. Get one
  file the laser already accepts and treat it as the reference spec.
- Bend allowances use the default K of 0.44 until somebody calibrates.
  Settings → Bend calibration takes a folded test strip — angle, radius, both
  legs measured to the apex, and the blank length — and solves for K, then
  writes it into the material's bend table where the unfold engine picks it up.

## Trying it without installing

The app runs in a plain browser as well as under Tauri, so there is a web
build at **https://klanok.github.io/Metal-Mate/** for showing someone the tool
without an installer and a SmartScreen warning. Save and open fall back to a
download and a file picker; everything else — the 3D view, the flat pattern,
validation, DXF export — is the same code the desktop app runs.

It is a demo, not a replacement, and it is a **public URL**. Take it down with
Settings → Pages → Source → None, or by deleting
`.github/workflows/pages.yml`.

## Installing

**Download an installer** from the [Releases page](../../releases) — a `.exe`
for Windows, `.dmg` for macOS, `.AppImage` or `.deb` for Linux. Nothing else
needs installing; the app is self-contained.

Releases are cut by pushing a tag. One job creates the draft release, then
each installer is built on its own operating system and uploaded into it:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The Actions tab can also run the release workflow by hand, which is the way to
produce a build to test without minting a version number.

The workflow refuses to build a tag that is already published — re-cutting a
version somebody already has is how two people end up with different software
under one number — and refuses to start if more than one draft exists for the
tag, since the installers would be split across them.

**Bump the version on `main` before building, not on a branch.** Publishing a
draft through the GitHub web UI submits its own target branch, overwriting the
`target_commitish` the workflow passes, so the tag is minted at `main`'s head
whichever branch produced the installers. v0.1.7 was built from a branch and
its tag landed on the v0.1.6 commit: the installers were correct, the tag
pointed at source that did not match them. The guard rails above cannot catch
this one, because from the workflow's side nothing went wrong.

The version lives in three files and they move together — `tauri.conf.json`,
`Cargo.toml`, and the `metal-mate` entry in `Cargo.lock`. Edit that last one by
line: `crypto-common` also sits at `0.1.7`, so a find-and-replace across the
lockfile silently changes a dependency.

> The installers are **not code signed**, because a certificate costs real
> money and there are two users. Windows SmartScreen warns on first run —
> *More info* then *Run anyway*. macOS needs right-click then *Open* the first
> time. Both are one-off, per machine.

## Developing

```bash
npm install
npm test          # 272 tests
npm run test:ui -w @metal-mate/app   # 26 browser tests on the built bundle
npm run typecheck
npm run dev       # the UI in a browser, no Rust toolchain needed
npm run tauri dev # the real desktop app
```

The app runs in a plain browser as well as under Tauri — file save and open
fall back to a download and a file picker — which keeps the whole UI usable
without a desktop build.

Building the desktop app needs a Rust toolchain, and on Linux the webview
development packages:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf
```

`npm run tauri build` produces an installer in
`app/src-tauri/target/release/bundle/`, for the operating system you run it on
— a Windows `.exe` has to be built on Windows, which is why releases go
through CI rather than one developer's machine.

## The pipeline

```ts
import {
  initBooleans, benchtopPart, build, exportDxf, GENERIC_2500_40T, formatReport,
} from '@metal-mate/core';

await initBooleans();          // loads the Clipper2 WASM kernel, once

const part = benchtopPart({
  name: 'Kitchen benchtop',
  partId: 'BT-001',
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: 1.2,
  materialId: 'ss304',
  bendRadiusMm: 1.2,
  edges: {
    front: { style: 'square-drop', heightMm: 40 },
    back:  { style: 'upstand',     heightMm: 100 },   // the splashback
    left:  { style: 'square-drop', heightMm: 40 },
    right: { style: 'none',        heightMm: 0 },
  },
  cutouts: [
    { kind: 'sink', id: 'sink1', fromLeftMm: 400, fromFrontMm: 90,
      widthMm: 400, depthMm: 350, cornerRadiusMm: 10 },
  ],
  grain: 'length',
});

const result = build(part, { machine: GENERIC_2500_40T });
console.log(formatReport(result.report));
console.log(result.flat.bounds, `${result.massKg.toFixed(1)} kg`);

const dxf = exportDxf(result);   // throws if validation found any error
```

All dimensions in and out are millimetres. Benchtop parameters are *outside*
dimensions; the template converts them to tangent-to-tangent legs.

## Layout

```
core/       domain library — pure functions, no DOM, no Tauri, no filesystem
app/        Tauri 2 + React shell; src-tauri/ is the Rust window and dialogs
fixtures/   approved golden DXF files
docs/       architecture document
```

`app/` uses `core/`. `core/` never learns that `app/` exists, which is what
keeps the whole domain testable in Node.
