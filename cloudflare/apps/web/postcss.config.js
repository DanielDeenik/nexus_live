// Runs Tailwind and Autoprefixer over src/index.css. Without this file Vite
// ships the @tailwind directives unprocessed and every utility class is lost.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
