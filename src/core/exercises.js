// Exercise catalogue. Each exercise turns a set of pose landmarks into
//  - the joint angle that is tracked for repetitions, and
//  - per-frame compensation checks (common ways patients "cheat" a movement).
//
// Landmark indices follow MediaPipe Pose (33 points). "left"/"right" are the patient's sides.

import { jointAngle, tiltFromVertical, midpoint, minVisibility } from './geometry.js';

export const LM = Object.freeze({
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
});

const other = (side) => (side === 'left' ? 'right' : 'left');

function trunkTilt(lm) {
  const sh = midpoint(lm[LM.left.shoulder], lm[LM.right.shoulder]);
  const hp = midpoint(lm[LM.left.hip], lm[LM.right.hip]);
  return tiltFromVertical(sh, hp);
}

/**
 * @typedef {object} Exercise
 * @property {string} id
 * @property {number} rest     default rest angle (deg)
 * @property {number} target   default target angle (deg); the therapist can change it
 * @property {[number, number]} targetRange slider bounds
 * @property {string[]} triple landmark names [a, vertex, c] of the tracked angle
 * @property {'front'|'side'} view recommended camera view
 * @property {(lm: object[], side: 'left'|'right') => {angle:number, visibility:number, flags:string[]}} measure
 */

/** @type {Exercise[]} */
export const EXERCISES = [
  {
    id: 'shoulder_abduction',
    triple: ['hip', 'shoulder', 'elbow'],
    rest: 15,
    target: 150,
    targetRange: [60, 175],
    view: 'front',
    measure(lm, side) {
      const s = LM[side];
      const pts = [lm[s.hip], lm[s.shoulder], lm[s.elbow], lm[s.wrist]];
      const angle = jointAngle(lm[s.hip], lm[s.shoulder], lm[s.elbow]);
      const flags = [];
      if (trunkTilt(lm) > 10) flags.push('trunk_lean');
      if (jointAngle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]) < 145) flags.push('elbow_bent');
      // Shoulder hiking: the working shoulder rises clearly above the other one.
      const sh = lm[s.shoulder], sho = lm[LM[other(side)].shoulder];
      const shoulderWidth = Math.abs(sh.x - sho.x) || 1e-6;
      if ((sho.y - sh.y) / shoulderWidth > 0.15) flags.push('shoulder_hike');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
  {
    id: 'shoulder_flexion',
    triple: ['hip', 'shoulder', 'elbow'],
    rest: 15,
    target: 160,
    targetRange: [60, 180],
    view: 'side',
    measure(lm, side) {
      const s = LM[side];
      const pts = [lm[s.hip], lm[s.shoulder], lm[s.elbow], lm[s.wrist]];
      const angle = jointAngle(lm[s.hip], lm[s.shoulder], lm[s.elbow]);
      const flags = [];
      if (tiltFromVertical(lm[s.shoulder], lm[s.hip]) > 12) flags.push('trunk_lean');
      if (jointAngle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]) < 145) flags.push('elbow_bent');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
  {
    id: 'elbow_flexion',
    triple: ['shoulder', 'elbow', 'wrist'],
    rest: 165,
    target: 45,
    targetRange: [30, 120],
    view: 'side',
    measure(lm, side) {
      const s = LM[side];
      const pts = [lm[s.shoulder], lm[s.elbow], lm[s.wrist], lm[s.hip]];
      const angle = jointAngle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]);
      const flags = [];
      // Upper arm should stay close to the trunk; swinging it forward is a classic compensation.
      if (jointAngle(lm[s.hip], lm[s.shoulder], lm[s.elbow]) > 25) flags.push('upper_arm_swing');
      if (tiltFromVertical(lm[s.shoulder], lm[s.hip]) > 12) flags.push('trunk_lean');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
  {
    id: 'knee_extension_seated',
    triple: ['hip', 'knee', 'ankle'],
    rest: 90,
    target: 170,
    targetRange: [110, 180],
    view: 'side',
    measure(lm, side) {
      const s = LM[side];
      const pts = [lm[s.hip], lm[s.knee], lm[s.ankle], lm[s.shoulder]];
      const angle = jointAngle(lm[s.hip], lm[s.knee], lm[s.ankle]);
      const flags = [];
      // Leaning back to lift the leg higher.
      if (tiltFromVertical(lm[s.shoulder], lm[s.hip]) > 15) flags.push('trunk_lean');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
  {
    id: 'mini_squat',
    triple: ['hip', 'knee', 'ankle'],
    rest: 170,
    target: 110,
    targetRange: [70, 150],
    view: 'front',
    measure(lm, side) {
      const s = LM[side], o = LM[other(side)];
      const pts = [lm[s.hip], lm[s.knee], lm[s.ankle], lm[o.hip], lm[o.knee], lm[o.ankle]];
      const angle = jointAngle(lm[s.hip], lm[s.knee], lm[s.ankle]);
      const otherAngle = jointAngle(lm[o.hip], lm[o.knee], lm[o.ankle]);
      const flags = [];
      // Offloading the injured leg shows up as an asymmetric knee bend.
      if (Math.abs(angle - otherAngle) > 15) flags.push('asymmetry');
      // Knee valgus: in a frontal view, knee collapses inward past the hip–ankle line.
      const hip = lm[s.hip], knee = lm[s.knee], ankle = lm[s.ankle];
      const midX = (hip.x + ankle.x) / 2;
      const legLen = Math.hypot(hip.x - ankle.x, hip.y - ankle.y) || 1e-6;
      const inward = side === 'left' ? midX - knee.x : knee.x - midX; // image is not mirrored here
      if (inward / legLen > 0.08) flags.push('knee_valgus');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
  {
    id: 'hip_abduction_standing',
    triple: ['shoulder', 'hip', 'knee'],
    rest: 178,
    target: 150,
    targetRange: [140, 172],
    view: 'front',
    measure(lm, side) {
      const s = LM[side];
      const pts = [lm[s.shoulder], lm[s.hip], lm[s.knee], lm[s.ankle]];
      // 180° = leg in line with trunk; lifting the leg sideways closes this angle.
      const angle = jointAngle(lm[s.shoulder], lm[s.hip], lm[s.knee]);
      const flags = [];
      if (trunkTilt(lm) > 10) flags.push('trunk_lean');
      if (jointAngle(lm[s.hip], lm[s.knee], lm[s.ankle]) < 160) flags.push('knee_bent');
      return { angle, visibility: minVisibility(pts), flags };
    },
  },
];

export function getExercise(id) {
  const ex = EXERCISES.find((e) => e.id === id);
  if (!ex) throw new Error(`Unknown exercise: ${id}`);
  return ex;
}

/** Pick the body side whose landmarks for this exercise are more visible. */
export function autoSide(exercise, lm) {
  const l = exercise.measure(lm, 'left').visibility;
  const r = exercise.measure(lm, 'right').visibility;
  return l >= r ? 'left' : 'right';
}
