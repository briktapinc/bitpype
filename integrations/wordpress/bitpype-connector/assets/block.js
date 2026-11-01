/**
 * BitPype Form block (editor side). The block is dynamic: PHP renders
 * the actual form embed server-side, so this script only provides
 * the editor picker. The form list (names + ids) is localized by PHP
 * as window.bitpypeBlockForms.
 */
(function (blocks, element, blockEditor, components) {
  var el = element.createElement;
  var InspectorControls = blockEditor.InspectorControls;
  var SelectControl = components.SelectControl;
  var PanelBody = components.PanelBody;

  blocks.registerBlockType('bitpype/form', {
    title: 'BitPype Form',
    description: 'A form from your BitPype account. Submissions arrive in your BitPype portal.',
    icon: 'feedback',
    category: 'widgets',
    attributes: {
      formId: { type: 'number', default: 0 },
    },
    edit: function (props) {
      var forms = Array.isArray(window.bitpypeBlockForms) ? window.bitpypeBlockForms : [];
      var options = [{ label: 'Choose a form…', value: 0 }].concat(forms);
      var current = forms.filter(function (f) {
        return Number(f.value) === Number(props.attributes.formId);
      })[0];
      return el(
        element.Fragment,
        null,
        el(
          InspectorControls,
          null,
          el(
            PanelBody,
            { title: 'BitPype form', initialOpen: true },
            el(SelectControl, {
              label: 'Form',
              value: props.attributes.formId,
              options: options,
              onChange: function (value) {
                props.setAttributes({ formId: Number(value) });
              },
            })
          )
        ),
        el(
          'div',
          { style: { border: '1px dashed #8c8f94', padding: '16px', textAlign: 'center' } },
          current ? 'BitPype form: ' + current.label : 'Choose a BitPype form in the block settings →'
        )
      );
    },
    save: function () {
      return null;
    },
  });
})(window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components);
