# Metal Mate — working rules

Desktop 3D sheet metal modeller: fold parts, unfold them to accurate flat
patterns, export DXF for the laser. First real workload is stainless benchtops.
Two users. No deadline. **Correctness over speed** — if a choice is between
shipping sooner and being sure the part folds up right, be sure.

Read this before changing anything in `core/`.

---

## Invariants

These are load-bearing. Breaking one is a design change, not a bug fix; if you
think one needs to go, say so explicitly rather than quietly working around it.

1. **The face-bend graph is a tree.** Faces are nodes, bends are edges, every
   face is reachable from the base face by exactly one path. Closed corners are
   `CornerJoint` records that modify 2D profiles at unfold time — never graph
   edges. `checkGraph` enforces this and `unfold` refuses to run without it.

2. **Millimetres, always.** Every length in every public API is a JS number in
   mm. No unit system, no inches, no document units. The only other
   representation is the integer grid inside `geometry/boolean.ts`, and it never
   escapes that module.

3. **Arcs are never linearised on the way out.** Arcs live as DXF bulges
   (`bulge = tan(theta/4)`) from sketch to file. They are linearised only as
   input to the boolean kernel, and re-fitted immediately afterwards. A 10 mm
   sink radius must arrive at the laser as an arc.

4. **DXF R12 (AC1009) ASCII only.** Maximum CAM compatibility. Group codes
   decide types: 0–9 strings, 10–59 doubles, 60–79 and 90–99 integers. Writing
   a float where an int16 belongs is malformed and some readers reject the file.

5. **Topological names, never indices.** Features refer to geometry as
   `top.front`, `frontDrop.tip`. Nothing anywhere may key off an array
   position. This is the classic parametric-CAD failure mode.

6. **Validation gates export.** Any finding of severity `error` sets
   `exportAllowed = false`, and `exportDxf` throws rather than write the file.
   This check lives in `pipeline.ts` so no caller can route around it. It is
   the feature that makes the tool trustworthy between the two users.

7. **Geometry is always derived, never stored.** The feature list is the source
   of truth. Project files hold features and template parameters; the graph,
   the flat pattern and the 3D solid are regenerated on load. A fixed bug in
   the unfold engine must improve every existing project.

8. **`core/` imports no DOM, no Tauri, no filesystem.** Pure functions over
   immutable data. It runs unchanged in Node for tests and in the UI process.

---

## Conventions the code depends on

**Bend line direction.** A bend stores its bend line twice, once in each face's
local frame, each directed so that *its own face's material is on the left*.
The two faces sit on opposite sides of the shared line, so the two directed
lines run antiparallel. That is what makes flat placement a pure rigid motion
with no mirroring. `checkGraph` verifies each stored line really is a
counter-clockwise boundary edge of its face.

**Face profiles lie on the neutral surface.** So the bend arc radius is
`BA / theta = R + K*T`, and the developed length across a bend is exactly the
bend allowance the flat pattern used. Flat and folded never need reconciling,
and the fold animation interpolates cleanly. Tangent points sit at the same
station on every parallel surface, so outside dimensions are unaffected.

**Bend rotation sign.** With `u` the bend line direction on face A and `n` face
A's normal, a rotation of `+theta` about `u` carries the far material toward
`-n`. A 'down' bend rotates `+theta`, an 'up' bend `-theta`. Direction has no
effect on the flat pattern, so only `test/fold.test.ts` can catch a sign error
here — keep those tests.

**Orientation.** Outer loops counter-clockwise (positive signed area), inner
loops clockwise. `profile()` normalises on construction; the DXF writer forces
it again on the way out.

**Angles.** `angleDeg` is the bend angle — the departure from flat. A
right-angle fold is 90, not 180.

**Outside vs leg dimensions.** Templates take *outside* dimensions, the way a
joiner dimensions a benchtop, and subtract one outside setback
(`tan(theta/2)(R+T)`, so `R+T` at 90°) per fold to get the tangent-to-tangent
leg lengths the graph wants.

---

## Numerical tolerances

The boolean kernel works on a 1 nm integer grid, so unfolded geometry is
quantised at 1e-6 mm. Do not write tests that expect the unfold to reproduce
an analytic value to more than about 5 decimal places, and do not "fix" such a
failure by tightening the grid — it is already far below anything a laser or
press brake can hold.

Anything comparing areas must scale its tolerance with part size: rounding
error grows with boundary length, so a fixed epsilon that suits a 100 mm
bracket will report a 1.8 m benchtop as self-overlapping. See
`overlapNoiseFloor` in `unfold/unfold.ts`.

---

## Layout

```
core/           domain library — no UI imports (see invariant 8)
  geometry/     vectors, loops with bulges, profiles, transforms, booleans
  model/        the face-bend graph and its structural checks
  features/     feature types and regeneration
  materials/    materials, bend tables, allowance resolution
  machine/      press brake profile, dies, tonnage
  unfold/       unfold engine and the folded 3D view
  validate/     validation rules and the report that gates export
  templates/    benchtop (v1); canopy later, over the unchanged core
  io/           DXF R12 writer, DXF reader/import, export profiles, project files
  pipeline.ts   part -> graph -> flat -> validation -> DXF, in order
app/            Tauri 2 + React shell
  src/render/   core output -> SVG paths and 3D geometry (pure, tested in Node)
  src/state/    the one derivation: parameters -> build() -> every panel
  src/platform/ file save/open, native under Tauri and browser fallback
  src-tauri/    Rust: window, menus, dialogs. No domain logic lives here.
fixtures/       golden DXF files
docs/           the architecture document
```

The layering is one-way: `io` and `templates` may use `model` and `geometry`;
nothing may reach back up. `templates/` must stay ignorant of `core/`'s
internals beyond the public feature types — the canopy pack in v2 is the test
of whether that held. `app/` may use `core/`; `core/` must never learn that
`app/` exists.

---

## The app

The UI holds parameters, never geometry — same rule as invariant 7. Everything
on screen comes from one `build()` call, so there is no path by which the
viewport, the flat preview and the DXF can disagree.

Keep logic out of components. Anything worth testing goes in `src/render/` or
`src/state/` where it can be tested in Node; components should be thin enough
that reading them tells you what they draw.

The boolean kernel is WebAssembly, so the app must pass the bundler's URL for
it: `initBooleans({ wasmUrl })`. Core takes a plain string and stays free of
any bundler or DOM dependency.

`src-tauri/` stays thin on purpose. Domain logic in Rust would be code the
Node test suite cannot reach, so the rule is: if it can run in TypeScript, it
does.

---

## Testing

Tests are the control system for AI-generated code here. Written alongside or
before the feature, never after.

- Every validation rule needs a fixture that passes it and one that fails it.
- Golden DXF files in `fixtures/` are byte-compared. Re-approve intentional
  changes with `UPDATE_GOLDEN=1 npm test -w @metal-mate/core`, and **look at
  the diff before committing it** — that approval step is the whole point.
- The DXF writer is verified by parsing its output with the independent reader
  in `io/dxfReader.ts`, never by the writer agreeing with itself.
- `npm test` and `npm run typecheck` from the repo root must both be clean.

`await initBooleans()` once before any unfold or export; everything downstream
of it is synchronous.

---

## Open questions

Carried from the architecture doc, still unanswered. Do not invent answers:

- Which CAM/laser software does the fabricator run? This locks the export spec.
  Get one DXF the laser already accepts and treat it as the reference.
- Press brake make/model and die rack. Settings → Press brake now edits all of
  it — bed, tonnage, die rack, throat, open height, thickness range — and the
  record carries a `placeholder` flag that only a person can clear. Until
  somebody does, every tonnage and minimum-flange number in the validation
  report is an estimate and says so. **The numbers themselves are still
  unanswered.**
- Coved splashback junctions: annotate-only in v1. Confirm the shop rolls these
  after folding.
- Standard sink cutout corner radius (10 mm?) and its minimum distance from a
  bend zone.

- Weld gap at a closed corner. Defaults to one thickness, derived from the
  geometry rather than from what the welder wants. Ask the shop.
