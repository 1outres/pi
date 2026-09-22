{ lib, buildNpmPackage, fetchzip, makeWrapper, nodejs_24, src }:

let
  manifest = builtins.fromJSON (builtins.readFile "${src}/packages/coding-agent/package.json");
  modelData = fetchzip {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${manifest.version}.tgz";
    hash = "sha256-fCpYrrIRBO5gNIEV+rziDPk4oDgRnT37w2gY90/1p0Q=";
  };
in
buildNpmPackage {
  pname = "pi";
  inherit (manifest) version;
  inherit src;

  nodejs = nodejs_24;
  npmDepsHash = "sha256-fbxwpQHnrUihO9MU72m331Uwt9dv0fQtEjdJ9hU8UxA=";
  npmBuildScript = "build:offline";
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ makeWrapper ];

  postPatch = ''
    cp -r ${modelData}/dist/providers/data packages/ai/src/providers/data
    chmod -R u+w packages/ai/src/providers/data
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -r node_modules packages package.json "$out/lib/pi/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/packages/coding-agent/dist/bundle/cli.js"

    runHook postInstall
  '';

  meta = {
    description = manifest.description;
    homepage = "https://github.com/1outres/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = lib.platforms.unix;
  };
}
