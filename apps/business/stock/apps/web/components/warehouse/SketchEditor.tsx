'use client';

import dynamic from 'next/dynamic';

const SketchEditorCanvas = dynamic(() => import('./SketchEditorCanvas').then((mod) => mod.SketchEditorCanvas), {
  ssr: false,
  loading: () => <div className="sketch-loading" />
});

export function SketchEditor() {
  return <SketchEditorCanvas />;
}
