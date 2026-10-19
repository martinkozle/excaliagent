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
      ]
      (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              chromium
              git
            ];

            # Playwright e2e tests use the Nix chromium instead of downloading one.
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };

          formatter = pkgs.nixfmt;
        }
      );
}
