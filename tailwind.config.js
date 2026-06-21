/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.ejs",
    "./public/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#ec4899',
        'primary-focus': '#ec4899',
        'primary-content': '#ffffff',
        secondary: '#ec4899',
        accent: '#ec4899',
        neutral: '#1f2937',
        'base-100': '#ffffff',
        'base-200': '#fdf2f8',
        'base-300': '#fce7f3',
        info: '#3b82f6',
        success: '#10b981',
        warning: '#f59e0b',
        error: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        light: {
          primary: '#ec4899',
          'primary-focus': '#db2777',
          'primary-content': '#ffffff',
          secondary: '#ec4899',
          accent: '#f472b6',
          neutral: '#1f2937',
          'base-100': '#ffffff',
          'base-200': '#fdf2f8',
          'base-300': '#fce7f3',
          info: '#3b82f6',
          success: '#10b981',
          warning: '#f59e0b',
          error: '#ef4444',
        },
      },
    ],
  },
};
