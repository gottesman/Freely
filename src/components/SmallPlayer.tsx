import React from 'react';
import Player from './Player';

type Props = {
  onPIPtoggle?: (pip: boolean) => void;
};

export default function SmallPlayer(props: Props) {
  return <Player variant="small" {...props} />;
}