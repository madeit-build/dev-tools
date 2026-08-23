# One of two modules that both define services.caddy.virtualHosts. The merge
# across these two files is the whole point of the fixture: no recorded
# projection can fake it, because it happens inside the module system.
{
  boot.loader.grub.enable = false;
  fileSystems."/" = {
    device = "/dev/null";
    fsType = "ext4";
  };
  system.stateVersion = "26.05";

  services.caddy = {
    enable = true;
    virtualHosts."alpha.test".extraConfig = "reverse_proxy 127.0.0.1:31201";
  };

  systemd.services.alpha-app = {
    description = "alpha app";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = "/bin/sh -c 'sleep infinity'";
      Type = "simple";
      StateDirectory = "alpha";
    };
    environment.ALPHA_HOST = "127.0.0.1:31201";
  };

  # A oneshot, so the lifecycle split is exercised against a real evaluation
  # rather than only against a recorded fixture.
  systemd.services.alpha-seed = {
    description = "alpha seed";
    serviceConfig = {
      ExecStart = "/bin/sh -c 'true'";
      Type = "oneshot";
    };
  };
}
