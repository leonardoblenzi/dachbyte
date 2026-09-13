'use client';

import { Layer, Line, Rect, Stage, Text } from 'react-konva';

export function SketchEditorCanvas() {
  return (
    <div className="sketch-shell">
      <Stage width={720} height={420} className="konva-stage">
        <Layer>
          <Rect x={24} y={24} width={672} height={372} fill="#07111f" stroke="#1d3b57" strokeWidth={2} cornerRadius={8} />
          <Text x={46} y={46} text="H01" fontSize={18} fill="#eef4ff" fontStyle="bold" />
          <Line points={[110, 100, 620, 100]} stroke="#43eaff" strokeWidth={3} dash={[12, 8]} />
          <Line points={[110, 305, 620, 305]} stroke="#22f078" strokeWidth={3} dash={[12, 8]} />
          <Rect x={150} y={138} width={410} height={96} fill="rgba(11,130,255,0.28)" stroke="#43eaff" strokeWidth={2} cornerRadius={6} />
          {[0, 1, 2, 3, 4, 5].map((column) => (
            <Rect key={column} x={166 + column * 64} y={152} width={46} height={68} fill="rgba(34,240,120,0.20)" stroke="#22f078" strokeWidth={1} cornerRadius={4} />
          ))}
          <Text x={276} y={176} text="EST-03" fontSize={22} fill="#eef4ff" fontStyle="bold" />
          <Rect x={78} y={250} width={78} height={44} fill="rgba(255,201,110,0.20)" stroke="#ffc96e" strokeWidth={2} cornerRadius={6} />
          <Text x={91} y={263} text="DOCA" fontSize={16} fill="#ffc96e" />
        </Layer>
      </Stage>
    </div>
  );
}
