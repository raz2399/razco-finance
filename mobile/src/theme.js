// Razi-Tech colours, the same ones the dashboard uses.
export const C = {
  red: '#c0282d',
  blue: '#4a7fc1',
  cyan: '#29a8e0',
  grey: '#a8a8a8',
  ink: '#1a1c21',
  bg: '#f4f6f9',
  green: '#168a5a',
  amber: '#bf7b0a',
  line: '#e4e8ef',
  mute: '#6b7280',
  white: '#ffffff',
};

export const S = {
  card: {
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    padding: 16,
    marginBottom: 11,
  },
  label: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.9,
    color: C.mute,
    textTransform: 'uppercase',
  },
  big: {
    backgroundColor: C.red,
    borderRadius: 12,
    paddingVertical: 17,
    alignItems: 'center',
  },
  bigText: { color: C.white, fontSize: 16, fontWeight: '800' },
};
