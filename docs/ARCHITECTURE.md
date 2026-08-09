# Sheet Metal CAD — Architecture Document
**Desktop 3D sheet metal modeller with unfold-to-flat, DXF export for laser cutting, and PDF drawings**

Version 0.2 — Draft for review

Primary domain: **stainless steel benchtops** (edges, splashbacks, cutouts). Future domain: parametric ute canopies.
Users: two (author + fabricator friend). Built with AI assistance (Claude Code). No deadline — correctness over speed.

---

## 1. Purpose and scope

A desktop application for designing folded sheet metal parts in 3D, automatically unfolding them to accurate flat patterns, and producing:

1. **DXF** files ready for the fabricator's laser (one part per file, no nesting)
2. **PDF drawings** (folded views, dimensions, bend table) for checking and shop-floor reference

The first real workload is stainless benchtops: front edge folds, integral splashbacks, sink/hob cutouts, closed and welded corners. The architecture is a **generic sheet metal core with domain template packs on top** — benchtops first, ute canopy panels later. Templates generate ordinary feature trees, so nothing in the core knows what a benchtop is.

**In scope (v1)**

- Parametric 3D modelling of single-thickness folded parts
- Benchtop template: length/depth/thickness, edge profile, splashback, cutouts, corner treatment
- DXF/DWG profile **import** as a base sketch, plus sketch-from-scratch
- Automatic flat pattern with bend allowances from calibrated bend tables
- **Machine profile validation**: a part that can't be folded on the configured press brake cannot be exported
- Closed corners with configurable treatment (weld gap or tab-and-slot)
- DXF export tuned to the friend's laser; PDF drawing output

**Non-goals (v1)**

- General 3D CAD, assemblies, freeform surfaces
- Stretch-forming features (pressed drainer grooves, coved splashback radii formed by rolling — note these as annotations, don't model the deformation)
- Nesting, CAM, toolpaths
- Costing (deliberately deferred; the data for it — mass, cut length, bend count — falls out of the model anyway)
- Multi-thickness or multi-body parts

---

## 2. Core insight: the face–bend graph

A folded part is fully described by a set of **planar faces** (each a 2D profile with cutouts) connected by **bends** (line, angle, direction, inside radius). The canonical model is a graph — nodes are faces, edges are bends — and it must form a tree. The 3D view and the flat pattern are both *derived* from this graph:

```
FaceBendGraph
├── Face (node)
│   ├── profile: outer loop (lines + arcs)
│   ├── cutouts: inner loops
│   ├── grain_direction (stainless polish grain — see §3.5)
│   └── local frame
└── Bend (edge)
    ├── faceA, faceB, shared bend line
    ├── angle (signed up/down), inside radius
    └── allowance override (optional)
```

- **Unfolding = graph traversal**: place faces in a plane, offsetting each across its bend by the bend allowance.
- **Folding (3D) = the same traversal** with rotations. A fold/unfold animation slider is nearly free.
- No general B-rep kernel is needed. This keeps the whole system small enough for a two-person user base and AI-assisted development to maintain.

**Corners** (two flanges meeting, e.g. a benchtop end cap meeting the front edge) live *alongside* the graph as `CornerJoint` records referencing two face edges, with a treatment: `weld_gap(g)` (default for stainless — cut back both flanges by g, welded and polished in the shop) or `tab_slot(params)` (self-fixturing for the canopy work later). Corner treatment only modifies the 2D profiles at unfold time; it never adds graph edges, so the tree property is preserved.

---

## 3. System architecture

Layered, one-way dependencies, core is a pure library with no UI imports:

```
┌──────────────────────────────────────────────────┐
│  UI: 3D viewport · sketcher · template wizards   │
│      feature tree · flat preview · export dialog │
├──────────────────────────────────────────────────┤
│  Application: commands · undo/redo · selection   │
│      document mgmt · validation reporting        │
├──────────────────────────────────────────────────┤
│  Domain templates: Benchtop (v1) · Canopy (v2)   │
│      → generate/maintain feature trees           │
├──────────────────────────────────────────────────┤
│  Core: feature model → face–bend graph →         │
│      unfold engine → flat pattern → validation   │
├──────────────────────────────────────────────────┤
│  Services: materials/bend tables · machine       │
│      profiles · DXF read/write · PDF · SQLite    │
└──────────────────────────────────────────────────┘
```

### 3.1 Feature model

Editable feature tree, regenerated on every parameter change (target < 50 ms typical parts):

| Feature | Notes |
|---|---|
| Base flange | From sketch **or imported DXF profile** + thickness |
| Edge flange | Length, angle, radius; supports multi-fold chains (see benchtop edge) |
| Hem | Open/closed/teardrop (safety edges) |
| Cutout | Circles, slots, rounded rectangles (sink/hob), imported profiles |
| Tab / notch | Add/remove material |
| Corner joint | Weld gap / tab-slot between two flange edges |
| Reliefs | Bend and corner reliefs, auto with manual override |

**Topological naming:** features reference geometry by stable hierarchical IDs (`base.profile.seg2`, `frontEdge.tip`), never positional indices. This is the classic parametric-CAD failure mode; it's designed in from day one and covered by regression tests.

### 3.2 Benchtop template (v1 flagship)

A wizard/panel that owns a parameter set and emits a feature tree:

- Plan size (L × D), thickness (0.9–1.6 mm typical), material
- **Front edge profile**: chosen from a small library — square fold-down, fold-down + return under, full boxed edge — each a predefined flange chain with editable drop/return dimensions
- **Splashback**: none / integral (fold up at rear, height parameter) / separate part (generates a second part in the same document)
- **Ends**: open, folded-down end caps, or ends meeting the front edge with a corner joint
- **Cutouts**: sink/hob rectangles with corner radius, tap holes, positioned from edges
- Grain direction annotation (length-wise by default)

The template stays "live": editing wizard parameters regenerates its features, but the user can also drop to the raw feature tree for one-offs. The **canopy template** later is the same pattern — proof the template layer is genuinely generic.

### 3.3 2D geometry engine

Everything reduces to robust 2D ops on line+arc profiles: booleans (cutouts, reliefs, corner treatments), offsetting (hems, returns), containment, loop orientation (outer CCW, inner CW). Use **Clipper2** (via WASM or native binding depending on stack, §4) behind a thin arc-aware interface: linearise arcs at fine tolerance for booleans, re-fit arcs afterwards where segments came from arc primitives. Highest-robustness-risk component — isolated behind an interface, heaviest test coverage.

### 3.4 Unfold engine

Bend allowance per bend: `BA = θ(R + K·T)`, with K (or direct bend deduction) resolved in order: bend override → bend table (material, thickness, V-die) → material default → global default (0.44). Algorithm: pick base face (default: the benchtop top), DFS the graph, place faces + bend-zone rectangles, union into one outer loop, transform cutouts, apply corner treatments, record bend lines with metadata (angle, direction, radius, die).

### 3.5 Materials, machine profile, and validation

**Materials:** editable records — Stainless 304 / 316 (the v1 defaults), plus Zincalume/Colorbond/aluminium for later; thickness list in mm; default K; optional per-thickness bend table (V-die → K or BD). Calibration is a first-class workflow: fold a test strip on the actual brake, measure, back-solve K, save. **Grain direction** is carried per part and written to the DXF/PDF as an annotation (polished stainless must be nested with grain aligned; the laser operator needs to see it).

**Machine profile — "if it can't be bent, it can't be cut":** a first-class record describing the friend's press brake:

```
MachineProfile
├── bed length (max bend line length)
├── tonnage + tonnage-per-metre chart (material, thickness, V-die)
├── available V-dies (width, min flange = f(V), radius produced)
├── punch radii available
├── throat / gap depth (limits box depth for return bends)
├── open height & backgauge reach (limits already-folded geometry
│   colliding with ram — box height rule of thumb)
└── min/max thickness per material
```

Validation runs on every regen and gates export:

| Check | Severity |
|---|---|
| Bend line longer than bed | **Error — blocks export** |
| Required tonnage exceeds machine | **Error** |
| Flange shorter than min for smallest suitable V-die | **Error** |
| No available die produces requested inside radius | Warning + suggest nearest |
| Fold sequence collision (deep box vs open height/throat) — v1 uses conservative heuristics (max flange depth vs throat), not full simulation | Warning |
| Unfold self-intersection / overlap | **Error** |
| Missing bend/corner relief | Warning + auto-fix |
| Cutout too close to bend zone (distortion) | Warning, configurable distance |

Export dialog shows the validation report; errors disable the DXF button. This is the feature that makes the tool trustworthy between you and the fabricator.

### 3.6 DXF import

For starting from an architect's/joiner's detail: read DXF (R12–R2018 via a library, e.g. ezdxf-class), let the user pick a closed loop (with inner loops) from a preview, heal it (join near-coincident endpoints within tolerance, fit arcs), and adopt it as a base flange profile. Import is *conversion to native sketch geometry* — after import there is no live link to the source file.

### 3.7 DXF export

- **Format: DXF R12 (AC1009) ASCII** — maximum CAM compatibility. `POLYLINE`/`VERTEX` with **bulge values for arcs — never linearised**. Closed flags set, deduplicated vertices, no zero-length segments, outer CCW / inner CW, origin at flat-pattern lower-left.
- **Calibrate against reality:** before finalising the writer, obtain one sample DXF the friend's laser already accepts cleanly and treat it as the reference spec (layer names, arc handling, units flag). An `ExportProfile` record stores per-laser layer mapping so defaults can be remapped without code changes.

Default layers:

| Layer | Content | Colour |
|---|---|---|
| `CUT_OUTER` | Outer profile | white |
| `CUT_INNER` | Cutouts, holes | yellow |
| `BEND_UP` / `BEND_DOWN` | Bend lines by direction | green / red, dashed |
| `ETCH` | Part ID, grain arrow | cyan |
| `INFO` | Bend angles/radii text, notes (non-cutting) | grey |

Writer implemented in-house (R12 is a simple tagged text format), verified by an independent parser in the test suite.

### 3.8 PDF drawing output

One-click drawing sheet (A3 landscape default):

- Isometric/front/end views of the folded part (projected from the same tessellation as the viewport)
- Flat pattern with overall dimensions and cutout positions
- **Bend table**: bend #, angle, direction, inside radius, die, developed position
- Material, thickness, grain arrow, part ID, date, revision
- Rendered via a 2D drawing abstraction shared with the flat-pattern view, output through a PDF library (§4)

Purpose: the friend checks the PDF before cutting; it also travels to the brake as the folding instruction sheet.

### 3.9 Persistence

Single-file **SQLite** project (`.smp`): schema version, settings, ordered feature records as JSON (parametric history is the source of truth — geometry always regenerated), template parameter sets, embedded copies of custom material/machine records for portability, thumbnail. Migrations from v1.

---

## 4. Technology stack — chosen for AI-assisted development

Because Claude Code is writing this, the stack is optimised for: mainstream ecosystems the model knows deeply, fast iteration, strong typing to catch AI mistakes, and a test-first workflow. Recommendation:

| Concern | Choice | Rationale |
|---|---|---|
| Shell | **Tauri 2** | Real desktop app (menus, file dialogs, small binary) with a web UI — the most productive UI environment for AI-generated code |
| UI | **TypeScript + React** | Strict TS everywhere; typed feature/parameter models catch a large class of generation errors at compile time |
| 3D viewport | **Three.js** | Modest needs (flat prisms + bend cylinders, edges overlay); enormous training-data coverage |
| Core domain | **TypeScript package** (`core/`), zero DOM/Tauri imports | Pure functions over immutable data; runs in Node for tests and in the UI unchanged |
| 2D booleans | Clipper2 **WASM** build | Battle-tested robustness without native build pain |
| DXF write | In-house R12 writer (TS) | ~300 lines; golden-file tested |
| DXF read | `dxf-parser`-class TS library, healing layer in-house | Import only needs entity access |
| PDF | `pdf-lib` or SVG→PDF pipeline | Shares the 2D drawing abstraction with flat view |
| Persistence | SQLite via Tauri plugin | Atomic saves, migrations |
| Tests | Vitest + golden files | See §5 — the backbone of AI-driven development |

Rust/C++ + Qt remains the "classic CAD" answer, but for a two-user tool built by AI, TypeScript end-to-end minimises context-switching and maximises the model's effectiveness. The core-as-pure-library rule keeps the door open to porting hot paths (unfold, booleans) to Rust/WASM later if performance ever demands it — benchtop-scale parts (tens of faces) won't.

**Repo shape for Claude Code:** monorepo with `core/` (domain, no UI), `app/` (Tauri+React), `fixtures/` (golden parts + DXFs), `CLAUDE.md` capturing the invariants in this document (graph-is-a-tree, mm-only, R12-only, topological IDs, validation-gates-export) so every session starts with the rules loaded.

---

## 5. Testing strategy

Testing is the control system for AI-generated code — written alongside or before features, never after:

- **Unit tests** on `core/`: regen, graph construction, unfold placement, allowance resolution, corner treatments, every validation rule (each rule gets a passing and failing fixture part)
- **Golden-file DXF tests:** reference parts — plain benchtop, benchtop + splashback + sink cutout, boxed-edge benchtop with weld-gap corners, Z-flashing, hemmed panel — byte-compared against approved DXF; diffs require explicit approval
- **Property tests:** random valid feature trees → unfold → assert loop closure, no overlap false-negatives, flat area ≥ folded projected area
- **Machine-profile tests:** parts deliberately violating each brake limit must fail export
- **Import round-trip:** export → import → re-export produces identical geometry
- **Real-world smoke:** open exports in LibreCAD/QCAD + the friend's actual CAM; periodically cut and fold a test part — the calibration workflow doubles as the accuracy test

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 2D boolean robustness (arcs, tangencies) | Clipper2, fixed-point µm coordinates internally, isolated interface, heaviest test coverage |
| Bend accuracy disputes with the shop | Calibration workflow first-class; bend tables per die |
| Friend's laser rejects DXF | Sample-file-as-spec before writer is finalised; ExportProfile remapping |
| Fold-collision check over-promises | v1 ships conservative heuristics clearly labelled as such; full sequence simulation is explicitly out of scope |
| Sketcher scope creep | Dimensions + snapping only; templates carry most geometry creation, shrinking sketcher pressure |
| Topological naming bugs | Hierarchical stable IDs + regression fixtures from day one |
| AI-generated regressions | Golden files + invariants in CLAUDE.md + CI running full suite on every change |

---

## 7. MVP and roadmap

**MVP — prove the pipeline with one real benchtop:**

1. Benchtop template: L×D×T, square fold-down front edge, integral splashback, one sink cutout
2. Unfold with overlap detection; 304 with default K
3. Machine profile with bed length + min flange checks gating export
4. DXF R12 export (validated against the friend's sample file)
5. 3D viewport + flat preview; save/load

**Definition of MVP success:** the friend cuts an MVP-exported benchtop, it folds up correct first try.

**v1.0:** edge profile library (return, boxed), corner joints (weld gap), DXF import, PDF drawings, bend tables + calibration workflow, full validation set, ETCH labels + grain arrow, fold animation.

**v1.x:** tab-and-slot corners, hems, separate-splashback multi-part documents, batch export.

**v2 — canopy template pack:** parametric ute canopy panels (sides, roof, doors, wing profiles) over the unchanged core — the real test that the template architecture holds.

---

## Appendix A — Bend allowance reference

```
θ = bend angle (rad)   R = inside radius   T = thickness   K = K-factor

Bend allowance   BA   = θ(R + KT)
Outside setback  OSSB = tan(θ/2)(R + T)        [θ ≤ 90°]
Bend deduction   BD   = 2·OSSB − BA
Flat length           = Σ flange lengths (apex) − Σ BD
Min flange (rule)     ≈ 0.7 × V-die width  (verify per die table)
Tonnage/m (approx)    ≈ 1.42 × UTS × T² / V   (check against brake chart;
                        stainless ≈ 1.5× mild steel)
```

## Appendix B — DXF R12 skeleton

```
0                     0
SECTION               POLYLINE
2                     8
HEADER                CUT_OUTER
9                     66
$INSUNITS             1
70                    70
4    ← millimetres    1    ← closed
0                     ...VERTEX records
ENDSEC                (42 = bulge for arcs)...
0                     0
SECTION               SEQEND
2                     0
TABLES                ENDSEC
...LAYER table...     0
0                     EOF
ENDSEC
0
SECTION
2
ENTITIES  →
```

## Appendix C — Open questions

- Which CAM/laser software does the friend run? (Locks the export spec)
- Press brake make/model + die rack inventory (populates the machine profile)
- Coved (radiused) splashback junctions: annotate-only in v1 — confirm the shop rolls these post-fold
- Sink cutout corner radii standard (10 mm?) and minimum distance from bend zone
