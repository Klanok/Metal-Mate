/**
 * Flat pattern preview.
 *
 * Drawn as SVG with real arc commands, on the same layer colours the DXF uses,
 * so what the user checks here is what the laser will get.
 */

import { useMemo } from 'react';
import type { FlatPattern } from '@metal-mate/core';
import { bendLabelAnchor, flatPatternView } from '../render/flatSvg.js';

export interface FlatPreviewProps {
  readonly flat: FlatPattern | null;
  readonly showBendLines: boolean;
}

export function FlatPreview({ flat, showBendLines }: FlatPreviewProps): JSX.Element {
  const view = useMemo(() => (flat === null ? null : flatPatternView(flat)), [flat]);

  if (view === null) {
    return <div className="flat-preview empty">No flat pattern</div>;
  }

  // Margin in model units so the outline never touches the edge of the frame.
  const margin = Math.max(view.widthMm, view.heightMm) * 0.04;
  const viewBox = [
    view.box.x - margin,
    -(view.box.y + view.box.height) - margin,
    view.box.width + margin * 2,
    view.box.height + margin * 2,
  ].join(' ');
  // One CSS pixel is worth this many millimetres at the current fit, which is
  // what keeps line weights and text the same size whatever the part size.
  const unit = Math.max(view.widthMm, view.heightMm) / 500;

  return (
    <div className="flat-preview" data-testid="flat-preview">
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Flat pattern">
        {/* Model space is y-up; SVG is y-down. Flip once, here. */}
        <g transform="scale(1,-1)">
          <path className="cut-outer" d={view.outerPath} strokeWidth={unit * 1.4} />
          {view.innerPaths.map((d, i) => (
            <path key={i} className="cut-inner" d={d} strokeWidth={unit * 1.4} />
          ))}
          {showBendLines &&
            view.bendLines.map((line) => (
              <line
                key={line.bendId}
                className={line.direction === 'up' ? 'bend-up' : 'bend-down'}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                strokeWidth={unit * 1.2}
                strokeDasharray={`${unit * 6} ${unit * 4}`}
              />
            ))}
        </g>
        {showBendLines &&
          view.bendLines.map((line) => {
            const at = bendLabelAnchor(line);
            return (
              <text
                key={`${line.bendId}-label`}
                className="bend-label"
                x={at.x}
                y={-at.y - unit * 4}
                fontSize={unit * 12}
                textAnchor="middle"
              >
                {line.label}
              </text>
            );
          })}
      </svg>
      <div className="flat-preview-caption">
        blank {view.widthMm.toFixed(1)} × {view.heightMm.toFixed(1)} mm
      </div>
    </div>
  );
}
