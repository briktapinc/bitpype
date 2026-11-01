<?php
/**
 * BitPype Connector — uninstall: clean exit.
 *
 * Best-effort goodbye to BitPype (so the portal marks this site
 * DISCONNECTED instead of leaving it looking connected), then every
 * option this plugin stored is deleted — including the site
 * credential. Page content is NOT touched: shortcodes the owner
 * placed stay in their pages and simply render nothing once the
 * plugin is gone (the portal's setup instructions say to remove
 * them). Because the credential is wiped, reinstalling this same
 * downloaded copy cannot reconnect — its registration code was
 * already spent; the owner downloads a fresh copy from the portal.
 *
 * @package BitpypeConnector
 */

if (! defined('WP_UNINSTALL_PLUGIN')) {
	exit;
}

require_once __DIR__ . '/bitpype-config.php';

$bitpype_site_key = trim((string) get_option('bitpype_site_key', ''));
$bitpype_app_url  = defined('BITPYPE_APP_URL') ? untrailingslashit(trim((string) BITPYPE_APP_URL)) : '';
if ('' !== $bitpype_site_key && '' !== $bitpype_app_url) {
	wp_remote_post(
		$bitpype_app_url . '/api/v1/wordpress/disconnect',
		array(
			'timeout' => 3,
			'headers' => array(
				'Content-Type'      => 'application/json',
				'X-Bitpype-Site-Key' => $bitpype_site_key,
			),
			'body'    => wp_json_encode(array('reason' => 'uninstalled')),
		)
	);
}

foreach (array(
	'bitpype_site_key',
	'bitpype_link_state',
	'bitpype_connector_status',
	'bitpype_status_checked_at',
	'bitpype_forms_cache',
	'bitpype_forms_cached_at',
) as $bitpype_option) {
	delete_option($bitpype_option);
}
