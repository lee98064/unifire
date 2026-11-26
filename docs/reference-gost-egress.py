#!/usr/bin/env python3
"""Select the hourly UniFi egress policy for go-gost."""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path
import subprocess
import tempfile
from zoneinfo import ZoneInfo


CONFIG = Path('/etc/gost-egress/config.json')
CA = Path('/etc/gost-egress/unifi-ca.pem')
ROUTES = '/proxy/network/v2/api/site/default/trafficroutes'
CONTROLLER = 'https://unifi.local'


class UniFi:
    def __init__(self, directory, ca):
        self.cookie = directory / 'cookie'
        self.cookie.touch(mode=0o600)
        self.headers = directory / 'headers'
        self.csrf = directory / 'csrf'
        self.ca = ca

    def login(self, credentials):
        self.request('POST', '/api/auth/login', json.loads(credentials.read_text()))
        for header in self.headers.read_text().splitlines():
            if header.lower().startswith('x-csrf-token:'):
                self.csrf.write_text(header + '\n')
                break
        if not self.csrf.is_file():
            raise RuntimeError('UniFi did not return a CSRF token')

    def request(self, method, path, body=None):
        command = [
            'curl', '-q', '--silent', '--show-error', '--noproxy', '*',
            '--connect-timeout', '5', '--max-time', '12', '--cacert', str(self.ca),
            '--resolve', 'unifi.local:443:192.168.30.1', '--cookie', str(self.cookie),
            '--request', method, '--write-out', '\n%{http_code}',
        ]
        if path == '/api/auth/login':
            command.extend(['--cookie-jar', str(self.cookie), '--dump-header', str(self.headers)])
        elif self.csrf.is_file():
            command.extend(['--header', '@' + str(self.csrf)])
        if body is not None:
            command.extend(['--header', 'Content-Type: application/json', '--data-binary', '@-'])
        result = subprocess.run(
            [*command, CONTROLLER + path],
            input=json.dumps(body) if body is not None else '',
            text=True, capture_output=True,
        )
        if result.returncode:
            raise RuntimeError(f'UniFi request failed ({result.returncode}): {result.stderr.strip()}')
        payload, _, status = result.stdout.rpartition('\n')
        if not status.startswith('2'):
            raise RuntimeError(f'UniFi {method} {path} returned HTTP {status}')
        return json.loads(payload) if payload.strip() else None


def selected_exit(schedule, hour):
    if hour == 0:
        return schedule['midnight']
    cycle = schedule['vpn_cycle']
    return cycle[(hour - 1) % len(cycle)]


def find_route(api, config):
    routes = api.request('GET', ROUTES)
    route = next((item for item in routes if item['_id'] == config['route_id']), None)
    expected_source = [{'type': 'CLIENT', 'client_mac': config['client_mac']}]
    if (route is None or route['description'] != config['route_name']
            or route['target_devices'] != expected_source or route['matching_target'] != 'INTERNET'
            or route.get('origin_type') or not route['kill_switch_enabled'] or not route['enabled']):
        raise RuntimeError('The enabled go-gost policy route does not match the configured rule')
    return route


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='show the intended exit without updating UniFi')
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    credentials = Path(os.environ['CREDENTIALS_DIRECTORY']) / 'unifi.json'
    now = datetime.now(ZoneInfo('Asia/Taipei'))
    target = selected_exit(config, now.hour)
    with tempfile.TemporaryDirectory(prefix='gost-egress-') as tmp:
        api = UniFi(Path(tmp), CA)
        api.login(credentials)
        route = find_route(api, config)
        if route['network_id'] == target['id']:
            print(f'{now:%Y-%m-%d %H:%M %Z} egress already set to {target["name"]}')
        elif args.check:
            print(f'{now:%Y-%m-%d %H:%M %Z} egress would change to {target["name"]}')
        else:
            route['network_id'] = target['id']
            api.request('PUT', f'{ROUTES}/{config["route_id"]}', route)
            if find_route(api, config)['network_id'] != target['id']:
                raise RuntimeError('UniFi did not report the requested egress after updating the route')
            print(f'{now:%Y-%m-%d %H:%M %Z} egress changed to {target["name"]}')


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from error
