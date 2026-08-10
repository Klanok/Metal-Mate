/**
 * The folded 3D view.
 *
 * Faces are extruded prisms, bends are curved slabs, and the fold slider drives
 * `fold(fraction)` in the core — the same traversal that produces the flat
 * pattern, so what you see here and what gets cut cannot drift apart.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FaceBendGraph, FoldedPart } from '@metal-mate/core';
import { bendPieces, facePieces, partExtent } from '../render/solid.js';

export interface Viewport3DProps {
  readonly graph: FaceBendGraph | null;
  readonly folded: FoldedPart | null;
  readonly showEdges: boolean;
}

const FACE_COLOUR = 0xc9d3da;
const BEND_UP_COLOUR = 0x74b06a;
const BEND_DOWN_COLOUR = 0xc4685f;

export function Viewport3D({ graph, folded, showEdges }: Viewport3DProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    partGroup: THREE.Group;
    dispose: () => void;
  } | null>(null);
  // Frame the part on the first render and whenever its size changes a lot,
  // but not on every fold tick — that would fight the user's own orbiting.
  const framedRadius = useRef<number>(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1f23);

    const camera = new THREE.PerspectiveCamera(45, 1, 1, 100_000);
    camera.position.set(900, -1400, 900);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1, -1.6, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-1.2, 1, -0.6);
    scene.add(fill);

    const partGroup = new THREE.Group();
    scene.add(partGroup);

    let running = true;
    const animate = (): void => {
      if (!running) return;
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    // Track the last size so a resize that changes nothing cannot feed itself.
    let lastWidth = 0;
    let lastHeight = 0;
    const resize = (): void => {
      const { clientWidth, clientHeight } = mount;
      if (clientWidth === 0 || clientHeight === 0) return;
      if (clientWidth === lastWidth && clientHeight === lastHeight) return;
      lastWidth = clientWidth;
      lastHeight = clientHeight;
      // Let Three set the canvas CSS size as well as its drawing buffer. With
      // updateStyle off, the canvas has no CSS size and so displays at buffer
      // size — which is devicePixelRatio times larger than its box. That grows
      // the container, ResizeObserver fires, and the canvas doubles again on
      // every tick. On a 200% display it reaches millions of pixels wide in a
      // second and the viewport goes black. Invisible at 100% scaling, which
      // is why it survived a browser smoke test.
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      partGroup,
      dispose: () => {
        running = false;
        observer.disconnect();
        controls.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    clearGroup(ctx.partGroup);
    if (graph === null || folded === null) return;

    for (const piece of facePieces(graph, folded)) {
      const shape = new THREE.Shape(piece.outer.map((p) => new THREE.Vector2(p.x, p.y)));
      shape.holes = piece.holes.map(
        (hole) => new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))),
      );
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: piece.thickness,
        bevelEnabled: false,
        curveSegments: 1,
      });
      geometry.applyMatrix4(new THREE.Matrix4().fromArray([...piece.matrix]));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: FACE_COLOUR,
          metalness: 0.65,
          roughness: 0.32,
          side: THREE.DoubleSide,
        }),
      );
      mesh.name = piece.label;
      ctx.partGroup.add(mesh);
      if (showEdges) ctx.partGroup.add(edgesOf(geometry));
    }

    for (const piece of bendPieces(folded)) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(piece.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(piece.indices, 1));
      geometry.computeVertexNormals();
      ctx.partGroup.add(
        new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: piece.direction === 'up' ? BEND_UP_COLOUR : BEND_DOWN_COLOUR,
            metalness: 0.5,
            roughness: 0.45,
            side: THREE.DoubleSide,
          }),
        ),
      );
    }

    const extent = partExtent(graph, folded);
    const changedALot =
      framedRadius.current === 0 ||
      extent.radius > framedRadius.current * 1.6 ||
      extent.radius < framedRadius.current / 1.6;
    if (changedALot) {
      framedRadius.current = extent.radius;
      ctx.controls.target.set(extent.centre.x, extent.centre.y, extent.centre.z);
      const distance = extent.radius * 2.6;
      ctx.camera.position.set(
        extent.centre.x + distance * 0.55,
        extent.centre.y - distance * 0.75,
        extent.centre.z + distance * 0.5,
      );
      ctx.camera.near = Math.max(1, extent.radius / 200);
      ctx.camera.far = extent.radius * 40;
      ctx.camera.updateProjectionMatrix();
      ctx.controls.update();
    }
  }, [graph, folded, showEdges]);

  return <div className="viewport" ref={mountRef} data-testid="viewport-3d" />;
}

function edgesOf(geometry: THREE.BufferGeometry): THREE.LineSegments {
  return new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 20),
    new THREE.LineBasicMaterial({ color: 0x2a3138 }),
  );
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  }
}
