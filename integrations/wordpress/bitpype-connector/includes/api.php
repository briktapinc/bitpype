<?php
/**
 * BitPype Connector — API client + connection state.
 *
 * The plugin talks to the BitPype app in these ways:
 *   1. Registration (once per downloaded copy): the registration code
 *      from bitpype-config.php is spent to bind this site and receive
 *      a scoped site credential.
 *   2. Heartbeats with that credential (status / lifecycle signals),
 *      which also carry the version + capability handshake.
 *   3. Fetching the workspace's form list (ids, names, public embed
 *      tokens) so forms can be placed on pages.
 *   4. Design sync (v2, includes/design.php): pushing the site
 *      census, pulling owner-approved design proposals, and
 *      reporting what was applied or undone.
 * Form submissions never pass through this plugin: visitors' browsers
 * post to BitPype's public form endpoints via form-embed.js, exactly
 * like forms on BitPype-hosted sites.
 *
 * @package BitpypeConnector
 */

if (! defined('ABSPATH')) {
	exit;
}

/**
 * The BitPype app base URL from this copy's generated config.
 *
 * @return string
 */
function bitpype_connector_app_url() {
	$url = defined('BITPYPE_APP_URL') ? BITPYPE_APP_URL : '';
	return untrailingslashit(trim((string) $url));
}

/**
 * This copy's registration code (spent after a successful connect).
 *
 * @return string
 */
function bitpype_connector_registration_token() {
	$token = defined('BITPYPE_REGISTRATION_TOKEN') ? BITPYPE_REGISTRATION_TOKEN : '';
	return trim((string) $token);
}

/**
 * The stored scoped site credential, if this site is registered.
 *
 * @return string
 */
function bitpype_connector_site_key() {
	return trim((string) get_option('bitpype_site_key', ''));
}

/**
 * What this plugin build can do (Batch 117 capability handshake —
 * reported on register + ping so the portal knows which features
 * this install supports: v1 reported nothing and stays forms-only).
 *
 * @return string[]
 */
function bitpype_connector_capabilities() {
	return array('forms', 'design1');
}

/**
 * Version + capabilities, merged into register/ping payloads.
 *
 * @return array{plugin_version:string,capabilities:string[]}
 */
function bitpype_connector_plugin_info() {
	return array(
		'plugin_version' => BITPYPE_CONNECTOR_VERSION,
		'capabilities'   => bitpype_connector_capabilities(),
	);
}

/**
 * Local connection status: connected|disconnected|revoked|spent|unregistered.
 *
 * @return string
 */
function bitpype_connector_status() {
	return (string) get_option('bitpype_connector_status', 'unregistered');
}

/**
 * One HTTP call to the BitPype app.
 *
 * @param string     $method GET|POST.
 * @param string     $path   Path under /api/v1/wordpress.
 * @param array|null $body   JSON body for POST.
 * @param bool       $use_key Send the site credential header.
 * @return array{code:int,data:array|null,error:string,error_code:string}
 */
function bitpype_connector_request($method, $path, $body = null, $use_key = true) {
	$base = bitpype_connector_app_url();
	if ('' === $base) {
		return array(
			'code'       => 0,
			'data'       => null,
			'error'      => 'This copy of the plugin has no BitPype address configured.',
			'error_code' => 'NO_APP_URL',
		);
	}
	$args = array(
		'method'  => $method,
		'timeout' => 10,
		'headers' => array('Content-Type' => 'application/json'),
	);
	if ($use_key) {
		$key = bitpype_connector_site_key();
		if ('' !== $key) {
			$args['headers']['X-Bitpype-Site-Key'] = $key;
		}
	}
	if (null !== $body) {
		$args['body'] = wp_json_encode($body);
	}
	$response = wp_remote_request($base . '/api/v1/wordpress' . $path, $args);
	if (is_wp_error($response)) {
		return array(
			'code'       => 0,
			'data'       => null,
			'error'      => $response->get_error_message(),
			'error_code' => 'HTTP_ERROR',
		);
	}
	$code = (int) wp_remote_retrieve_response_code($response);
	$data = json_decode((string) wp_remote_retrieve_body($response), true);
	$out  = array(
		'code'       => $code,
		'data'       => is_array($data) ? $data : null,
		'error'      => '',
		'error_code' => '',
	);
	if ($code < 200 || $code >= 300 || ! is_array($data) || empty($data['ok'])) {
		$out['error']      = is_array($data) && ! empty($data['error']) ? (string) $data['error'] : 'BitPype returned an unexpected response.';
		$out['error_code'] = is_array($data) && ! empty($data['code']) ? (string) $data['code'] : 'HTTP_' . $code;
	}
	return $out;
}

/**
 * Spend this copy's registration code to connect THIS site.
 * Stores the derived site credential on success.
 *
 * @return array The request result (see bitpype_connector_request()).
 */
function bitpype_connector_register() {
	$result = bitpype_connector_request(
		'POST',
		'/register',
		array_merge(
			array(
				'token'       => bitpype_connector_registration_token(),
				'site_url'    => home_url(),
				'site_name'   => get_bloginfo('name'),
				'admin_email' => get_bloginfo('admin_email'),
				'wp_version'  => get_bloginfo('version'),
			),
			bitpype_connector_plugin_info()
		),
		false
	);
	if (200 === $result['code'] && ! empty($result['data']['data']['site_key'])) {
		update_option('bitpype_site_key', (string) $result['data']['data']['site_key']);
		update_option('bitpype_link_state', 'registered');
		update_option('bitpype_connector_status', 'connected');
		update_option('bitpype_status_checked_at', time());
		bitpype_connector_fetch_forms();
		if (function_exists('bitpype_connector_push_census')) {
			bitpype_connector_push_census();
		}
		if (function_exists('bitpype_connector_design_sync')) {
			bitpype_connector_design_sync();
		}
	} elseif ('TOKEN_SPENT' === $result['error_code']) {
		update_option('bitpype_link_state', 'spent');
		update_option('bitpype_connector_status', 'spent');
	} elseif ('LINK_REVOKED' === $result['error_code']) {
		update_option('bitpype_link_state', 'spent');
		update_option('bitpype_connector_status', 'revoked');
	}
	return $result;
}

/**
 * Send a lifecycle/status signal with the site credential and fold
 * the answer into the local status. A 410 means the owner revoked
 * this site in the portal: fail closed locally.
 *
 * @param string $state active|status|deactivated|uninstalled.
 * @return array The request result.
 */
function bitpype_connector_ping($state) {
	$result = bitpype_connector_request(
		'POST',
		'/ping',
		array_merge(array('state' => $state), bitpype_connector_plugin_info()),
		true
	);
	update_option('bitpype_status_checked_at', time());
	if ('SITE_REVOKED' === $result['error_code'] || 410 === $result['code']) {
		update_option('bitpype_connector_status', 'revoked');
	} elseif (200 === $result['code'] && ! empty($result['data']['data']['status'])) {
		update_option('bitpype_connector_status', (string) $result['data']['data']['status']);
	}
	return $result;
}

/**
 * Ask BitPype to mark this registration disconnected (credential kept,
 * so Reconnect / reactivation can resume the same registration).
 *
 * @param string $reason deactivated|uninstalled|manual.
 * @return array The request result.
 */
function bitpype_connector_disconnect($reason) {
	$result = bitpype_connector_request('POST', '/disconnect', array('reason' => $reason), true);
	if (200 === $result['code']) {
		update_option('bitpype_connector_status', 'disconnected');
		update_option('bitpype_status_checked_at', time());
	}
	return $result;
}

/**
 * Refresh the cached list of this workspace's forms.
 *
 * @return array<int,array{id:int,name:string,token:string,shortcode:string}>
 */
function bitpype_connector_fetch_forms() {
	$result = bitpype_connector_request('GET', '/forms', null, true);
	if ('SITE_REVOKED' === $result['error_code'] || 410 === $result['code']) {
		update_option('bitpype_connector_status', 'revoked');
		return array();
	}
	if (200 !== $result['code'] || empty($result['data']['data']['forms']) || ! is_array($result['data']['data']['forms'])) {
		return bitpype_connector_cached_forms();
	}
	$forms = array();
	foreach ($result['data']['data']['forms'] as $form) {
		if (! is_array($form) || empty($form['id']) || empty($form['token'])) {
			continue;
		}
		$forms[] = array(
			'id'        => (int) $form['id'],
			'name'      => isset($form['name']) ? (string) $form['name'] : 'Form',
			'token'     => (string) $form['token'],
			'shortcode' => isset($form['shortcode']) ? (string) $form['shortcode'] : '',
		);
	}
	update_option('bitpype_forms_cache', $forms);
	update_option('bitpype_forms_cached_at', time());
	return $forms;
}

/**
 * The cached form list (never a network call).
 *
 * @return array
 */
function bitpype_connector_cached_forms() {
	$forms = get_option('bitpype_forms_cache', array());
	return is_array($forms) ? $forms : array();
}

/**
 * Refresh the local status at most once per five minutes — this is
 * how a portal Revoke reaches the site promptly without a network
 * call on every page view. Network failure keeps the last status.
 */
function bitpype_connector_maybe_refresh_status() {
	if ('' === bitpype_connector_site_key()) {
		return;
	}
	$checked = (int) get_option('bitpype_status_checked_at', 0);
	if (time() - $checked < 300) {
		return;
	}
	bitpype_connector_ping('status');
}
