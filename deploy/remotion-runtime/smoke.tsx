import React from 'react';
import {loadFont} from '@remotion/fonts';
import {AbsoluteFill, Composition, registerRoot, staticFile} from 'remotion';

const family = 'Presenter Noto Sans SC';
void loadFont({
  family,
  url: staticFile('fonts/NotoSansCJKSC-Regular.otf'),
  weight: '400',
  format: 'opentype',
});

const SmokeFrame: React.FC = () => (
  <AbsoluteFill
    style={{
      alignItems: 'center',
      backgroundColor: '#f3f5f2',
      color: '#17201d',
      display: 'flex',
      fontFamily: `${family}, sans-serif`,
      fontSize: 54,
      fontWeight: 700,
      justifyContent: 'center',
    }}
  >
    中文字体渲染正常 Remotion runtime ready
  </AbsoluteFill>
);

const SmokeRoot: React.FC = () => (
  <Composition id="RuntimeSmoke" component={SmokeFrame} durationInFrames={1} fps={25} width={1280} height={720} />
);

registerRoot(SmokeRoot);
