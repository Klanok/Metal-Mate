/**
 * Canopy template wizard.
 *
 * Dimensions are **outside** sizes, the way somebody measures a ute tray. The
 * template cuts every panel to the neutral-surface box — one thickness smaller
 * in each direction — because that is what a butt-welded corner is, so the
 * panel sizes shown here are deliberately not the numbers typed above them.
 *
 * The one piece of real construction is the lip: each wall turns inward at the
 * top and bottom, and the roof and floor land on those lips. Everything else is
 * still skeleton — square corners, no window apertures, no tapers, no tabs. The
 * panel says so rather than letting somebody assume otherwise from a
 * clean-looking form.
 */

import type { CanopyDoor, CanopyMeasures, CanopyParams, DoorWall, Material } from '@metal-mate/core';
import { DOOR_WALLS, canopyMeasures, canopyPanels } from '@metal-mate/core';
import { NumberField } from './NumberField.js';

const WALL_LABELS: Record<DoorWall, string> = {
  left: 'Left side',
  right: 'Right side',
  rear: 'Rear',
};

/**
 * Add or remove one wall's door, keeping the others as they are.
 *
 * A new door copies the numbers off whatever door already exists, so ticking a
 * second side gives you the pair you just set up rather than the defaults.
 */
function setDoor(params: CanopyParams, wall: DoorWall, on: boolean): CanopyDoor[] {
  const doors = (params.doors ?? []).filter((d) => d.wall !== wall);
  if (!on) return doors;
  const like = params.doors?.[0];
  return [...doors, like === undefined ? { wall } : { ...like, wall }];
}

/**
 * The numbers shown in the shared fields, taken from the first door.
 *
 * The core allows every door its own margins; this panel deliberately does not,
 * because three sets of six numbers is a form nobody fills in correctly and a
 * canopy whose left door is a different size from its right one is a mistake
 * far more often than it is a design.
 */
function firstDoor(params: CanopyParams): CanopyDoor {
  return params.doors?.[0] ?? { wall: 'left' };
}

function patchDoors(params: CanopyParams, next: Partial<CanopyDoor>): CanopyDoor[] {
  return (params.doors ?? []).map((d) => ({ ...d, ...next }));
}

/** Drop the rivet spec entirely rather than setting it undefined. */
function withoutRivets(params: CanopyParams): CanopyParams {
  const { rivet: _rivet, ...rest } = params;
  return rest;
}

function measuresOf(params: CanopyParams): CanopyMeasures | null {
  try {
    return canopyMeasures(params);
  } catch {
    return null;
  }
}

export interface CanopyPanelProps {
  readonly params: CanopyParams;
  readonly materials: readonly Material[];
  readonly onChange: (next: CanopyParams) => void;
}

export function CanopyPanel({ params, materials, onChange }: CanopyPanelProps): JSX.Element {
  const patch = (next: Partial<CanopyParams>): void => onChange({ ...params, ...next });
  const material = materials.find((m) => m.id === params.materialId);
  const t = params.thicknessMm;
  const lip = params.lipMm ?? 0;
  // A body that cannot be built has no dimensions to report; the parts list
  // says what is wrong with it, so this just goes quiet rather than throwing
  // out of a render.
  const measures = measuresOf(params);

  return (
    <section className="panel template" data-testid="canopy-panel">
      <h2>Canopy</h2>
      <p className="muted">All dimensions are outside sizes, in millimetres.</p>

      <fieldset>
        <legend>Box</legend>
        <NumberField label="Length" value={params.lengthMm} onChange={(v) => patch({ lengthMm: v })} />
        <NumberField label="Width" value={params.widthMm} onChange={(v) => patch({ widthMm: v })} />
        <NumberField label="Height" value={params.heightMm} onChange={(v) => patch({ heightMm: v })} />
        <label className="field toggle">
          <input
            type="checkbox"
            data-testid="canopy-floor"
            checked={params.floor !== false}
            onChange={(e) => patch({ floor: e.target.checked })}
          />
          <span>Include a floor — leave it off if the canopy sits on the ute&apos;s own tray</span>
        </label>
        <NumberField label="Lip" value={params.lipMm ?? 0} onChange={(v) => patch({ lipMm: v })} />
        <label className="field">
          <span>Top seam</span>
          <select
            data-testid="canopy-lip-on"
            value={params.lipOn ?? 'walls'}
            onChange={(e) => patch({ lipOn: e.target.value as 'walls' | 'roof' })}
          >
            <option value="walls">Walls lip in, roof lands on them</option>
            <option value="roof">Roof returns down, walls lap inside</option>
          </select>
        </label>
        <p className="muted" data-testid="canopy-lip-note">
          {lip <= 0
            ? 'Zero lip: the panels butt edge to edge, with nothing to bolt or clamp through.'
            : (params.lipOn ?? 'walls') === 'roof'
              ? `The roof turns ${lip} mm down outside each wall, mitred at every corner, and the wall laps up inside it. The top corner is a bend rather than a joint, so the rivets sit on the wall face below it instead of on the edge you look at. Outside height is still ${params.heightMm} mm.`
              : `Each wall turns ${lip} mm inward at the top and bottom, mitred at every corner. The roof lands on the top lips and the bottom lips land on the floor, so the outside height is still ${params.heightMm} mm.`}
        </p>
      </fieldset>

      <fieldset data-testid="canopy-rivets">
        <legend>Rivets</legend>
        <label className="field toggle">
          <input
            type="checkbox"
            data-testid="canopy-riveted"
            checked={params.rivet !== undefined}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? { ...params, rivet: params.rivet ?? { diameterMm: 4.8, pitchMm: 100 } }
                  : withoutRivets(params),
              )
            }
          />
          <span>Rivet the seams</span>
        </label>
        {params.rivet !== undefined && (
          <>
            <NumberField
              label="Rivet"
              value={params.rivet.diameterMm}
              step={0.2}
              onChange={(v) => patch({ rivet: { ...params.rivet!, diameterMm: v } })}
            />
            <NumberField
              label="Pitch"
              value={params.rivet.pitchMm}
              step={5}
              onChange={(v) => patch({ rivet: { ...params.rivet!, pitchMm: v } })}
            />
            <p className="muted" data-testid="canopy-rivet-note">
              Holes go down the middle of each lip at this pitch or a little under, so the run
              divides evenly. They are cut in the <strong>lip only</strong>: the spacing would match
              on the panel that lands on it, but how far the holes sit from the seam depends on the
              bend allowance, and K has not been measured for this shop yet. Clamp up and drill
              through.
            </p>
          </>
        )}
      </fieldset>

      <fieldset data-testid="canopy-taper">
        <legend>Taper</legend>
        <p className="muted">
          Length, width and height above are the <strong>footprint and the front</strong>. Leaning a
          wall in or dropping the roof changes what the back and the top measure, so those are
          reported below rather than assumed.
        </p>
        <NumberField
          label="Roof drop"
          value={params.roofDropMm ?? 0}
          onChange={(v) => patch({ roofDropMm: v })}
        />
        {(
          [
            ['leftDeg', 'Left lean'],
            ['rightDeg', 'Right lean'],
            ['frontDeg', 'Front lean'],
            ['rearDeg', 'Rear lean'],
          ] as const
        ).map(([field, label]) => (
          <NumberField
            key={field}
            label={label}
            unit="°"
            step={0.5}
            value={params.taperDeg?.[field] ?? 0}
            onChange={(v) => patch({ taperDeg: { ...params.taperDeg, [field]: v } })}
          />
        ))}
        {measures !== null && (
          <dl className="stats" data-testid="canopy-measures">
            <div>
              <dt>Roof width</dt>
              <dd>
                {measures.roofWidthFrontMm.toFixed(0)} front / {measures.roofWidthRearMm.toFixed(0)}{' '}
                rear
              </dd>
            </div>
            <div>
              <dt>Roof length</dt>
              <dd>{measures.roofLengthMm.toFixed(0)} mm</dd>
            </div>
            <div>
              <dt>Height at rear</dt>
              <dd>{measures.rearHeightMm.toFixed(0)} mm</dd>
            </div>
          </dl>
        )}
      </fieldset>

      <fieldset data-testid="canopy-doors">
        <legend>Doors</legend>
        <p className="muted">
          An opening is a hole in the wall and nothing more. A lip cannot be folded around it — a
          brake folds along a line that runs off both ends of the blank, so a return around a hole
          needs press tooling this shop has not got. The <strong>door</strong> does get a return on
          all four edges, because those are four straight bends off the edge of a rectangle.
        </p>
        {DOOR_WALLS.map((wall) => {
          const door = (params.doors ?? []).find((d) => d.wall === wall);
          return (
            <label className="field toggle" key={wall}>
              <input
                type="checkbox"
                data-testid={`canopy-door-${wall}`}
                checked={door !== undefined}
                onChange={(e) => patch({ doors: setDoor(params, wall, e.target.checked) })}
              />
              <span>{WALL_LABELS[wall]}</span>
            </label>
          );
        })}
        {(params.doors ?? []).length > 0 && (
          <>
            <NumberField
              label="Head"
              value={firstDoor(params).headMm ?? 60}
              step={5}
              onChange={(v) => patch({ doors: patchDoors(params, { headMm: v }) })}
            />
            <NumberField
              label="Sill"
              value={firstDoor(params).sillMm ?? 60}
              step={5}
              onChange={(v) => patch({ doors: patchDoors(params, { sillMm: v }) })}
            />
            <NumberField
              label="Jamb"
              value={firstDoor(params).jambMm ?? 60}
              step={5}
              onChange={(v) => patch({ doors: patchDoors(params, { jambMm: v }) })}
            />
            <NumberField
              label="Corner radius"
              value={firstDoor(params).cornerRadiusMm ?? 20}
              step={1}
              onChange={(v) => patch({ doors: patchDoors(params, { cornerRadiusMm: v }) })}
            />
            <NumberField
              label="Door lap"
              value={firstDoor(params).lapMm ?? 20}
              step={1}
              onChange={(v) => patch({ doors: patchDoors(params, { lapMm: v }) })}
            />
            <NumberField
              label="Door return"
              value={firstDoor(params).returnMm ?? 20}
              step={1}
              onChange={(v) => patch({ doors: patchDoors(params, { returnMm: v }) })}
            />
            <NumberField
              label="Swing open"
              value={firstDoor(params).openDeg ?? 0}
              step={5}
              onChange={(v) => patch({ doors: patchDoors(params, { openDeg: v }) })}
            />
            <p className="muted" data-testid="canopy-door-note">
              Head, sill and jamb are the frame: the top rail the door hangs off, the sill under it,
              and a post at each end. Cut in one piece rather than riveted up from four, which is
              stiffer and one job on the laser instead of four on the brake. The corner radius is
              not decoration — a square internal corner is where a crack starts, and this one spends
              its life being shaken on a ute.
            </p>
            <p className="muted" data-testid="canopy-swing-note">
              <strong>Swing open</strong> is a view, not a dimension. The doors are gullwings: they
              hinge on the top rail and lift up and out, so nothing fouls the tray side when you open
              one alongside a wall. Swinging them changes no blank, no bend and no flat pattern.
            </p>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Design</legend>
        <label className="field">
          <span>Name</span>
          <input type="text" value={params.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Part prefix</span>
          <input
            type="text"
            data-testid="canopy-prefix"
            value={params.partPrefix ?? ''}
            placeholder="CAN"
            onChange={(e) => patch({ partPrefix: e.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Material</legend>
        <label className="field">
          <span>Grade</span>
          <select value={params.materialId} onChange={(e) => patch({ materialId: e.target.value })}>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Thickness</span>
          <select
            value={String(params.thicknessMm)}
            onChange={(e) => patch({ thicknessMm: Number(e.target.value) })}
          >
            {(material?.thicknesses ?? [params.thicknessMm]).map((th) => (
              <option key={th} value={String(th)}>
                {th} mm
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Bend radius"
          value={params.bendRadiusMm}
          step={0.1}
          onChange={(v) => patch({ bendRadiusMm: v })}
        />
        <label className="field">
          <span>Grain</span>
          <select
            value={params.grain ?? 'length'}
            onChange={(e) => patch({ grain: e.target.value as NonNullable<CanopyParams['grain']> })}
          >
            <option value="length">Along length</option>
            <option value="width">Across width</option>
            <option value="none">None / unpolished</option>
          </select>
        </label>
      </fieldset>

      <fieldset data-testid="canopy-panels">
        <legend>Panels</legend>
        <p className="muted">
          {canopyPanels(params).length} panels, each cut {t} mm under the outside size: the corners
          meet on the neutral surface, so every dimension loses half a thickness at each end.
          {lip > 0 ? ' The walls are shorter again by what their lips take.' : ''}
        </p>
      </fieldset>

      <p className="caveat" data-testid="canopy-caveat">
        This is still the <strong>skeleton</strong> canopy: square corners, no window apertures, no
        tapers and no locating tabs. The seams have no weld gap yet, because a corner joint still
        applies within one part and these are between parts.
      </p>
    </section>
  );
}
