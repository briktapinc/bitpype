/**
 * BitPype Section block (editor side). The block is dynamic: PHP
 * renders the section server-side from the design state the portal
 * chat manages, so this script only provides the editor picker.
 * The section list is localized by PHP as window.bitpypeBlockZones.
 */
(function (blocks, element, blockEditor, components) {
  var el = element.createElement;
  var InspectorControls = blockEditor.InspectorControls;
  var SelectControl = components.SelectControl;
  var PanelBody = components.PanelBody;

  blocks.registerBlockType('bitpype/zone', {
    title: 'BitPype Section',
    description: 'A banner, hero or call-to-action section designed in your BitPype portal chat.',
    icon: 'layout',
    category: 'widgets',
    attributes: {
      zoneId: { type: 'string', default: '' },
    },
    edit: function (props) {
      var zones = Array.isArray(window.bitpypeBlockZones) ? window.bitpypeBlockZones : [];
      var options = [{ label: 'Choose a section…', value: '' }].concat(zones);
      var current = zones.filter(function (z) {
        return String(z.value) === String(props.attributes.zoneId);
      })[0];
      return el(
        element.Fragment,
        null,
        el(
          InspectorControls,
          null,
          el(
            PanelBody,
            { title: 'BitPype section', initialOpen: true },
            el(SelectControl, {
              label: 'Section',
              value: props.attributes.zoneId,
              options: options,
              onChange: function (value) {
                props.setAttributes({ zoneId: String(value) });
              },
            })
          )
        ),
        el(
          'div',
          { style: { border: '1px dashed #8c8f94', padding: '16px', textAlign: 'center' } },
          current
            ? 'BitPype section: ' + current.label
            : zones.length
              ? 'Choose a BitPype section in the block settings →'
              : 'No BitPype sections yet — design one in your BitPype portal chat first'
        )
      );
    },
    save: function () {
      return null;
    },
  });
})(window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components);
