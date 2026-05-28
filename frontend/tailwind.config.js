/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // Rare-Link AI 디자인 토큰 (v0.1)
      colors: {
        rl: {
          ink:          '#0A1628',
          'ink-2':      '#334155',
          'ink-3':      '#64748B',
          'ink-4':      '#94A3B8',
          border:       '#CBD5E1',
          'border-soft':'#E2E8F0',
          bg:           '#FFFFFF',
          'bg-2':       '#F8FAFC',
          'bg-3':       '#F1F5F9',
          primary:      '#0C447C',
          'primary-dark':'#083158',
          'primary-2':  '#1D5FAB',
          'primary-soft':'#EFF4FB',
          teal:         '#0E8574',
          'teal-soft':  '#E6F5F2',
          amber:        '#B45309',
          'amber-soft': '#FEF3C7',
          critical:     '#A32D2D',
          'critical-soft':'#FEE4E4',
          rare:         '#6B21A8',
          'rare-soft':  '#F3E8FF',
        },
      },
      fontFamily: {
        sans:  ["'IBM Plex Sans KR'", "'IBM Plex Sans'", 'sans-serif'],
        serif: ["'IBM Plex Serif'", 'Georgia', 'serif'],
        mono:  ["'IBM Plex Mono'", 'monospace'],
      },
    },
  },
  plugins: [],
};
