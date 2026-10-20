{
  description = "excaliagent development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachSystem
      [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ]
      (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          # nixpkgs has no chromium for macOS: there, Playwright downloads its own
          # (`npx playwright install chromium`).
          devShells.default = pkgs.mkShell (
            {
              packages = with pkgs; [
                nodejs_24
                git
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.chromium ];
            }
            // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
              # Playwright e2e tests use the Nix chromium instead of downloading one.
              PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            }
          );

          formatter = pkgs.nixfmt;
        }
      );
}
