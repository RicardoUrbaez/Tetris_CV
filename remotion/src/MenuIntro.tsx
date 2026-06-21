import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const colors = {
  bg: "#02060a",
  panel: "#07131f",
  cyan: "#14d9f4",
  green: "#65f05b",
  magenta: "#ff4aa2",
  amber: "#ffc429",
  text: "#f5fbff",
};

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeInOut = Easing.bezier(0.45, 0, 0.55, 1);

const Tile = ({
  x,
  y,
  color,
  delay,
}: {
  x: number;
  y: number;
  color: string;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = interpolate(frame, [delay * fps, delay * fps + 0.42 * fps], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 48,
        height: 48,
        borderRadius: 4,
        background: color,
        boxShadow: `0 0 ${24 * appear}px ${color}`,
        opacity: appear,
        transform: `translateY(${(1 - appear) * -90}px) scale(${0.7 + appear * 0.3})`,
      }}
    />
  );
};

const RailLine = ({ top, color, delay }: { top: number; color: string; delay: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [delay * fps, delay * fps + 1.1 * fps], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top,
        height: 2,
        width: `${draw * 100}%`,
        background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
        opacity: 0.7,
      }}
    />
  );
};

export const MenuIntro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const open = interpolate(frame, [0, 1.05 * fps], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const glow = interpolate(frame, [1.1 * fps, 2.4 * fps, 3.6 * fps], [0.25, 1, 0.42], {
    easing: easeInOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const boardSlide = interpolate(frame, [0.45 * fps, 1.45 * fps], [180, 0], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleReveal = interpolate(frame, [0.2 * fps, 1.25 * fps], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const tileBaseX = 1180;
  const tileBaseY = 650;
  const tiles = [
    [0, 5, colors.amber, 0.52],
    [1, 5, colors.amber, 0.58],
    [2, 5, colors.magenta, 0.64],
    [3, 5, colors.green, 0.7],
    [4, 5, colors.green, 0.76],
    [1, 4, colors.amber, 0.86],
    [2, 4, colors.magenta, 0.94],
    [3, 4, colors.magenta, 1.02],
    [4, 4, colors.green, 1.1],
    [2, 3, colors.cyan, 1.18],
    [2, 2, colors.cyan, 1.26],
    [2, 1, colors.cyan, 1.34],
    [5, 5, colors.cyan, 1.42],
  ];

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 18% 18%, rgba(20,217,244,0.25), transparent 28%), radial-gradient(circle at 78% 42%, rgba(255,74,162,0.18), transparent 30%), #02060a",
        color: colors.text,
        fontFamily: "Inter, Segoe UI, Arial, sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.26,
          backgroundImage:
            "linear-gradient(rgba(117,247,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(117,247,255,0.12) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          transform: `translateY(${frame * 0.45}px)`,
        }}
      />

      <RailLine top={184} color={colors.cyan} delay={0.1} />
      <RailLine top={900} color={colors.magenta} delay={0.32} />

      <div
        style={{
          position: "absolute",
          left: 150,
          top: 130,
          width: 1620,
          height: 820,
          border: `2px solid rgba(117,247,255,${0.22 + glow * 0.36})`,
          borderRadius: 10,
          background: "linear-gradient(145deg, rgba(8,18,29,0.72), rgba(4,10,16,0.58))",
          boxShadow: `0 0 ${70 * glow}px rgba(20,217,244,0.22), inset 0 0 90px rgba(0,0,0,0.72)`,
          opacity: open,
          transform: `scale(${0.96 + open * 0.04})`,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 230,
          top: 246,
          opacity: titleReveal,
          transform: `translateX(${(1 - titleReveal) * -90}px)`,
        }}
      >
        <div
          style={{
            fontSize: 116,
            lineHeight: 0.92,
            fontWeight: 950,
            letterSpacing: 10,
            textShadow: `0 0 ${30 * glow}px rgba(20,217,244,0.4)`,
          }}
        >
          TETRIS
        </div>
        <div
          style={{
            fontSize: 72,
            lineHeight: 1,
            fontWeight: 950,
            letterSpacing: 13,
            color: colors.green,
            textShadow: `0 0 ${26 * glow}px rgba(101,240,91,0.5)`,
          }}
        >
          HANDS
        </div>
        <div
          style={{
            marginTop: 36,
            display: "grid",
            gap: 16,
            width: 390,
          }}
        >
          {["SINGLE PLAYER", "MULTIPLAYER", "HOW TO PLAY"].map((label, index) => (
            <div
              key={label}
              style={{
                height: 62,
                display: "flex",
                alignItems: "center",
                paddingLeft: 26,
                border: `2px solid ${index === 0 ? colors.cyan : index === 1 ? colors.magenta : colors.amber}`,
                borderRadius: 8,
                background: "rgba(2,7,11,0.74)",
                color: colors.text,
                fontSize: 22,
                fontWeight: 850,
                letterSpacing: 4,
                opacity: interpolate(frame, [(0.8 + index * 0.15) * fps, (1.2 + index * 0.15) * fps], [0, 1], {
                  easing: easeOut,
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 248,
          top: 190,
          width: 430,
          height: 720,
          border: `2px solid rgba(117,247,255,${0.32 + glow * 0.32})`,
          background:
            "linear-gradient(rgba(117,247,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(117,247,255,0.12) 1px, transparent 1px), rgba(0,0,0,0.24)",
          backgroundSize: "43px 36px",
          transform: `translateX(${boardSlide}px)`,
          opacity: open,
        }}
      >
        {tiles.map(([x, y, color, delay]) => (
          <Tile
            key={`${x}-${y}`}
            x={32 + Number(x) * 56}
            y={44 + Number(y) * 56}
            color={String(color)}
            delay={Number(delay)}
          />
        ))}
      </div>

      <div
        style={{
          position: "absolute",
          right: 182,
          top: 238,
          width: 38,
          height: 560,
          display: "grid",
          gridTemplateRows: "repeat(5, 1fr)",
          gap: 18,
          opacity: interpolate(frame, [1.1 * fps, 2 * fps], [0, 1], {
            easing: easeOut,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        {[colors.amber, colors.green, colors.magenta, colors.amber, colors.cyan].map((color) => (
          <div
            key={color}
            style={{
              border: `2px solid ${color}`,
              boxShadow: `0 0 18px ${color}`,
              borderRadius: 4,
              background: color,
            }}
          />
        ))}
      </div>

      <div
        style={{
          position: "absolute",
          left: 230,
          bottom: 170,
          padding: "15px 22px",
          border: `2px solid rgba(101,240,91,${0.48 + glow * 0.3})`,
          borderRadius: 8,
          color: colors.green,
          fontSize: 18,
          fontWeight: 850,
          letterSpacing: 3,
          background: "rgba(2,7,11,0.72)",
          opacity: interpolate(frame, [1.35 * fps, 2.15 * fps], [0, 1], {
            easing: easeOut,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        CAMERA READY
      </div>
    </AbsoluteFill>
  );
};
