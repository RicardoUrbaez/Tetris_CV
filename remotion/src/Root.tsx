import { Composition } from "remotion";
import { MenuIntro } from "./MenuIntro";

export const RemotionRoot = () => {
  return (
    <Composition
      id="MenuIntro"
      component={MenuIntro}
      durationInFrames={120}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
