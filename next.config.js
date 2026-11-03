/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // PoC: react-dnd typings clash with React 18 types (src/pages/index.tsx)
  typescript: { ignoreBuildErrors: true },
}

module.exports = nextConfig
