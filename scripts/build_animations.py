#!/usr/bin/env python3
"""
Generates the Lottie character animations used by the Daily Goal card.

The files are built from code instead of downloaded so every state uses the
same character, and poses can be tweaked here and regenerated:

    python3 scripts/build_animations.py

Coordinates are authored around a (100, 100) origin with y pointing down. Lottie rotation is
clockwise-positive, so a limb drawn pointing down swings toward -x as its
rotation increases.
"""
import json
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "animations")
FR = 30

# Poses are authored around a (100, 100) origin; the canvas is cropped to the
# character's reach (overhead barbell, speed lines) so it can be drawn large
# without a margin of empty space around it.
CANVAS_W, CANVAS_H = 150, 170
SHIFT_X, SHIFT_Y = -25, -20


def shifted(v):
    return (v[0] + SHIFT_X, v[1] + SHIFT_Y)


def hexc(h, a=1):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [a]


SKIN = hexc("f2c9a0")
SHIRT = hexc("6c3ff0")
PANTS = hexc("2b2f8f")
HAIR = hexc("3cc6c9")
SHOE = hexc("1f2033")
INK = hexc("1f2033")
BAR = hexc("5b5d6b")
PLATE = hexc("f26b3a")


# ---------- Lottie primitives ----------

def static(v):
    return {"a": 0, "k": v}


def anim(keys, spatial=False):
    """keys: [(frame, value)], value is a number or a list."""
    if len(keys) == 1:
        return static(keys[0][1])
    frames = []
    for i, (t, v) in enumerate(keys):
        s = v if isinstance(v, list) else [v]
        kf = {"t": t, "s": s}
        if i < len(keys) - 1:
            if spatial:
                kf["i"] = {"x": 0.45, "y": 1}
                kf["o"] = {"x": 0.55, "y": 0}
                kf["to"] = [0, 0, 0]
                kf["ti"] = [0, 0, 0]
            else:
                n = len(s)
                kf["i"] = {"x": [0.45] * n, "y": [1] * n}
                kf["o"] = {"x": [0.55] * n, "y": [0] * n}
        frames.append(kf)
    return {"a": 1, "k": frames}


def prop(v, spatial=False):
    """Static value, or a keyframe list [(t, v), ...]."""
    if isinstance(v, list) and v and isinstance(v[0], tuple):
        return anim(v, spatial)
    return static(v)


def transform(p=(0, 0), r=0, a=(0, 0), s=(100, 100), o=100):
    def xyz(v):
        return [v[0], v[1], 0]

    if isinstance(p, list):
        p_prop = anim([(t, xyz(v)) for t, v in p], spatial=True)
    else:
        p_prop = static(xyz(p))
    if isinstance(s, list):
        s_prop = anim([(t, [v[0], v[1], 100]) for t, v in s])
    else:
        s_prop = static([s[0], s[1], 100])
    return {"o": prop(o), "r": prop(r), "p": p_prop, "a": static(xyz(a)), "s": s_prop}


def shape_tr():
    return {"ty": "tr", "p": static([0, 0]), "a": static([0, 0]), "s": static([100, 100]),
            "r": static(0), "o": static(100), "sk": static(0), "sa": static(0)}


def fill(c, opacity=100):
    # Lottie ignores the alpha channel of "c"; transparency must go through "o".
    return {"ty": "fl", "c": static(c), "o": static(opacity), "r": 1}


def stroke(c, w):
    return {"ty": "st", "c": static(c), "o": static(100), "w": static(w), "lc": 2, "lj": 2}


def ellipse(p, s):
    return {"ty": "el", "p": static(list(p)), "s": static(list(s)), "d": 1}


def rect(p, s, r):
    return {"ty": "rc", "p": static(list(p)), "s": static(list(s)), "r": static(r), "d": 1}


def line(a, b):
    return {"ty": "sh", "d": 1, "ks": static({
        "i": [[0, 0], [0, 0]], "o": [[0, 0], [0, 0]], "v": [list(a), list(b)], "c": False})}


def group(items):
    return {"ty": "gr", "it": items + [shape_tr()]}


class Scene:
    def __init__(self, name, op):
        self.name, self.op = name, op
        self.back_to_front = []
        self._ind = 0

    def add(self, name, ks, shapes=None, parent=None, null=False):
        self._ind += 1
        layer = {"ddd": 0, "ind": self._ind, "ty": 3 if null else 4, "nm": name, "sr": 1,
                 "ks": ks, "ao": 0, "ip": 0, "op": self.op, "st": 0, "bm": 0}
        if not null:
            layer["shapes"] = shapes or []
        if parent is not None:
            layer["parent"] = parent
        self.back_to_front.append(layer)
        return self._ind

    def lottie(self):
        return {"v": "5.7.4", "fr": FR, "ip": 0, "op": self.op, "w": CANVAS_W, "h": CANVAS_H,
                "nm": self.name, "ddd": 0, "assets": [],
                "layers": list(reversed(self.back_to_front))}


# ---------- Character ----------

UPPER_ARM, FOREARM, THIGH, SHIN = 22, 20, 26, 26


def build(name, op, pose, profile=False, extras=None):
    """pose: dict of joint -> static value or [(frame, value)] keyframes."""
    g = pose.get
    sc = Scene(name, op)
    shoulder_x = 5 if profile else 15
    hip_x = 3 if profile else 8
    torso_w = 22 if profile else 30

    sc.add("shadow", transform(p=shifted((100, 176))), [group([ellipse((0, 0), (64, 10)), fill(hexc("1f2033"), 12)])])
    if extras and "behind" in extras:
        extras["behind"](sc)

    root_p = g("root_p", (100, 100))
    root_p = [(t, shifted(v)) for t, v in root_p] if isinstance(root_p, list) else shifted(root_p)
    root = sc.add("root", transform(p=root_p, r=g("root_r", 0)), null=True)

    def limb(side, kind, x, y):
        up_len, lo_len, color = (UPPER_ARM, FOREARM, SHIRT) if kind == "arm" else (THIGH, SHIN, PANTS)
        up = sc.add(f"{kind}{side}_up", transform(p=(x, y), r=g(f"{kind}{side}_up", 0)),
                    [group([line((0, 0), (0, up_len)), stroke(color, 10)])], parent=root)
        end = ellipse((0, lo_len), (9, 9)) if kind == "arm" else ellipse((3 if profile else 0, lo_len + 1), (14, 8))
        end_fill = SKIN if kind == "arm" else SHOE
        sc.add(f"{kind}{side}_lo", transform(p=(0, up_len), r=g(f"{kind}{side}_lo", 0)),
               [group([end, fill(end_fill)]), group([line((0, 0), (0, lo_len)), stroke(color, 10)])],
               parent=up)
        return up

    # Profile view: the right-side limbs are the far side, so draw them first.
    far_side, near_side = ("R", "L") if profile else ("L", "R")
    order_x = {"L": -1, "R": 1}

    if profile:
        limb("R", "arm", order_x["R"] * shoulder_x, -20)
    limb(far_side, "leg", order_x[far_side] * hip_x, 22)
    limb(near_side, "leg", order_x[near_side] * hip_x, 22)

    sc.add("torso", transform(), [
        group([rect((0, 1), (torso_w, 44), 11), fill(SHIRT)]),
        group([rect((0, 22), (torso_w - 2, 14), 6), fill(PANTS)]),
    ], parent=root)

    head = sc.add("head", transform(p=(0, -42), r=g("head_r", 0)), [
        group([ellipse((2 if profile else 0, -9), (32, 17)), fill(HAIR)]),
        group([ellipse((0, 0), (30, 30)), fill(SKIN)]),
    ], parent=root)
    eye_dx = 4 if profile else 0
    sc.add("eyes", transform(p=(eye_dx, -1), s=g("eyes_s", (100, 100))), [
        group([ellipse((-5.5, 0), (3.6, 4.4)), ellipse((5.5, 0), (3.6, 4.4)), fill(INK)]),
    ], parent=head)
    sc.add("mouth", transform(p=(eye_dx, 7), s=g("mouth_s", (100, 100))), [
        group([ellipse((0, 0), (6, 2.6)), fill(INK)]),
    ], parent=head)

    if not profile:
        limb("L", "arm", -shoulder_x, -20)
        limb("R", "arm", shoulder_x, -20)
    else:
        limb("L", "arm", order_x["L"] * shoulder_x, -20)

    if extras and "front" in extras:
        extras["front"](sc)
    return sc.lottie()


def mirror(keys):
    if isinstance(keys, list):
        return [(t, -v) for t, v in keys]
    return -keys


# ---------- States ----------

def idle():
    breathe = [(0, (100, 100)), (30, (100, 101.5)), (60, (100, 100))]
    arm_l = [(0, 10), (30, 13), (60, 10)]
    return build("idle", 60, {
        "root_p": breathe,
        "armL_up": arm_l, "armL_lo": -6, "armR_up": mirror(arm_l), "armR_lo": 6,
        "legL_up": 3, "legL_lo": -3, "legR_up": -3, "legR_lo": 3,
        "head_r": [(0, 0), (30, 3), (60, 0)],
        "eyes_s": [(0, (100, 100)), (44, (100, 100)), (46, (100, 10)), (48, (100, 100)), (60, (100, 100))],
    })


def lift():
    up_l = [(0, 60), (18, 160), (30, 160), (48, 60), (60, 60)]
    lo_l = [(0, 120), (18, 0), (30, 0), (48, 120), (60, 120)]
    pose = {
        "root_p": [(0, (100, 102)), (18, (100, 99)), (30, (100, 99)), (48, (100, 102)), (60, (100, 102))],
        "armL_up": up_l, "armL_lo": lo_l, "armR_up": mirror(up_l), "armR_lo": mirror(lo_l),
        "legL_up": 8, "legL_lo": -8, "legR_up": -8, "legR_lo": 8,
        "eyes_s": [(0, (100, 100)), (18, (100, 55)), (30, (100, 55)), (48, (100, 100)), (60, (100, 100))],
        "mouth_s": [(0, (100, 100)), (18, (70, 260)), (30, (70, 260)), (48, (100, 100)), (60, (100, 100))],
    }

    def barbell(sc):
        # Parented to the left forearm and counter-rotated by the arm's total
        # angle, so it rides with the hand but always stays level.
        hand = next(l["ind"] for l in sc.back_to_front if l["nm"] == "armL_lo")
        total = [(t, -(a + b)) for (t, a), (_, b) in zip(up_l, lo_l)]
        sc.add("barbell", transform(p=(0, FOREARM), a=(-32, 0), r=total), [
            group([rect((-50, 0), (8, 24), 2), rect((50, 0), (8, 24), 2), fill(PLATE)]),
            group([rect((-43, 0), (4, 14), 1), rect((43, 0), (4, 14), 1), fill(BAR)]),
            group([line((-56, 0), (56, 0)), stroke(BAR, 4)]),
        ], parent=hand)

    return build("lift", 60, pose, extras={"front": barbell})


def run():
    pose = {
        "root_p": [(0, (100, 103)), (5, (100, 98)), (10, (100, 103)), (15, (100, 98)), (20, (100, 103))],
        "root_r": 8,
        "head_r": -5,
        "legL_up": [(0, -38), (10, 34), (20, -38)],
        "legL_lo": [(0, 12), (5, 20), (10, 85), (15, 60), (20, 12)],
        "legR_up": [(0, 34), (10, -38), (20, 34)],
        "legR_lo": [(0, 85), (5, 60), (10, 12), (15, 20), (20, 85)],
        "armL_up": [(0, 34), (10, -40), (20, 34)],
        "armL_lo": [(0, -50), (10, -95), (20, -50)],
        "armR_up": [(0, -40), (10, 34), (20, -40)],
        "armR_lo": [(0, -95), (10, -50), (20, -95)],
        "mouth_s": (100, 160),
    }

    def speed_lines(sc):
        for i, (y, length) in enumerate([(-14, 18), (2, 26), (18, 14)]):
            start = i * 3
            sc.add(f"speed{i}", transform(
                p=[(0, shifted((72 - start, 100 + y))), (20, shifted((54 - start, 100 + y)))],
                o=[(0, 0), (6, 80), (20, 0)],
            ), [group([line((0, 0), (-length, 0)), stroke(hexc("6c3ff0", 1), 3)])])

    return build("run", 20, pose, profile=True, extras={"behind": speed_lines})


def wake():
    up_l = [(0, 10), (20, 195), (62, 195), (78, 10), (90, 10)]
    lo_l = [(0, -6), (20, -15), (62, -15), (78, -6), (90, -6)]
    return build("wake", 90, {
        "root_p": [(0, (100, 100)), (20, (100, 97)), (62, (100, 97)), (75, (100, 100)), (90, (100, 100))],
        "root_r": [(0, 0), (20, 0), (35, -7), (50, 7), (62, 0), (90, 0)],
        "armL_up": up_l, "armL_lo": lo_l, "armR_up": mirror(up_l), "armR_lo": mirror(lo_l),
        "legL_up": 3, "legL_lo": -3, "legR_up": -3, "legR_lo": 3,
        "head_r": [(0, 0), (20, -4), (62, 4), (78, 0), (90, 0)],
        "eyes_s": [(0, (100, 100)), (10, (100, 15)), (62, (100, 15)), (70, (100, 100)),
                   (82, (100, 100)), (84, (100, 10)), (86, (100, 100)), (90, (100, 100))],
        "mouth_s": [(0, (100, 100)), (20, (140, 120)), (30, (160, 420)), (50, (160, 420)),
                    (60, (100, 100)), (90, (100, 100))],
    })


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for build_fn in (idle, lift, run, wake):
        data = build_fn()
        path = os.path.join(OUT_DIR, f"{data['nm']}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"wrote {path} ({os.path.getsize(path)} bytes, {len(data['layers'])} layers)")


if __name__ == "__main__":
    main()
