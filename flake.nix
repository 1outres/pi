{
  description = "Pi coding agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          pi = pkgs.callPackage ./nix/pi.nix { src = self; };
        in {
          inherit pi;
          default = pi;
        });

      checks = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          pi-starts = pkgs.runCommand "pi-starts" {
            nativeBuildInputs = [ self.packages.${system}.pi ];
          } ''
            pi --version > "$out"
          '';
          pi-models = pkgs.runCommand "pi-models" {
            modelData = "${self.packages.${system}.pi}/lib/pi/packages/ai/dist/providers/data/openai-codex.json";
          } ''
            grep -q '"gpt-6-sol"' "$modelData"
            touch "$out"
          '';
        });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.nodejs_24
              pkgs.git
              pkgs.ripgrep
            ];
          };
        });
    };
}
