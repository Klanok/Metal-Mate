# Metal Mate

Desktop 3D sheet metal modeller: design folded parts, unfold them to accurate
flat patterns, and export DXF for the laser. First real workload is stainless
steel benchtops — front edge folds, integral splashbacks, sink and hob cutouts.

The design is a **generic sheet metal core with domain template packs on top**.
The core knows about faces, bends, allowances and press brakes; it does not know
what a benchtop is. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full design, and [`CLAUDE.md`](CLAUDE.md) for the invariants any change has to
respect.

## Status

The domain core is built and tested end to end. The desktop application is not.

**Working today** (`core/`, 125 tests):

| Area | State |
|---|---|
| Face-bend graph + structural checks | tree invariant, bend-line direction convention, orientation |
| Feature model and regeneration | base flange, edge flange (with insets and multi-fold chains), cutouts |
| Topological naming | features address geometry as `top.front`, `frontDrop.tip` |
| Unfold engine | bend allowance placement, cutouts, overlap and island detection |
| Folded 3D view | face frames and bend arcs, fold fraction 0..1 for the animation |
| Materials and bend tables | 304/316, aluminium, Zincalume, mild steel; calibration back-solve from a measured test strip |
| Machine profile | bed, tonnage, die rack, throat, open height, thickness limits |
| Validation | 14 rules, each with a passing and a failing fixture; errors block export |
| Benchtop template | square drop / drop-and-return / boxed edge, integral splashback, sink, hob and tap cutouts |
| DXF R12 export | arcs as bulges, layer mapping via export profiles, golden-file tested |
| DXF import | reader plus healing (chains loose lines and arcs into closed loops) |
| Project files | JSON payload, schema version, migration seam |

**Not built yet:** the Tauri + React application (3D viewport, sketcher,
template wizard, feature tree, export dialog), PDF drawing output, corner
joints, and hems. The core exposes what those need — `fold()` returns face
frames and bend arcs for the viewport, `validate()` returns the report the
export dialog shows, and `build()`/`exportDxf()` are the pipeline the UI drives.

**Not yet verified against reality**, and this matters before anyone cuts metal:

- `GENERIC_2500_40T` is a **placeholder press brake**. Every tonnage and
  minimum-flange result is an estimate until it is replaced with the real
  machine's bed, tonnage chart and die rack.
- The DXF writer has not been checked against the fabricator's CAM. Get one
  file the laser already accepts and treat it as the reference spec.
- Bend allowances use the default K of 0.44. Fold a test strip and calibrate
  before trusting a flat pattern — `kFromFlatLength()` and `withBendRow()` are
  the workflow.

## Getting started

```bash
npm install
npm test          # 125 tests
npm run typecheck
```

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
  frontEdge: { style: 'square-drop', dropMm: 40 },
  splashback: { style: 'integral', heightMm: 100 },
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
fixtures/   approved golden DXF files
docs/       architecture document
app/        Tauri + React shell (not built yet)
```
