# The second definer of services.caddy.virtualHosts. definitionsWithLocations
# must attribute beta.test and static.test to this file, and alpha.test to the
# other one, rather than fanning all three out to both.
{
  services.caddy.virtualHosts."beta.test".extraConfig = "reverse_proxy 127.0.0.1:31202";

  # A vhost with no upstream at all, which must not produce a proxy edge.
  services.caddy.virtualHosts."static.test".extraConfig = ''
    root * /var/lib/static
    file_server
  '';

  systemd.services.beta-app = {
    description = "beta app";
    wantedBy = [ "multi-user.target" ];
    after = [ "alpha-app.service" ];
    serviceConfig = {
      ExecStart = "/bin/sh -c 'sleep infinity'";
      Type = "simple";
      StateDirectory = "beta beta/inner";
    };
    environment.BETA_HOST = "127.0.0.1:31202";
  };
}
