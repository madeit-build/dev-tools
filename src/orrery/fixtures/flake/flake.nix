{
  description = "orrery test fixture: a minimal fleet with a merged option";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    {
      nixosConfigurations.testbox = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          ./alpha.nix
          ./beta.nix
        ];
      };
    };
}
