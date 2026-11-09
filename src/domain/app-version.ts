// The single source of the displayed version is package.json; the release workflow checks it
// against tauri.conf.json and Cargo.toml before building.
export { version as APP_VERSION } from '../../package.json';
