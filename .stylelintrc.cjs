module.exports = {
    extends: ['stylelint-config-standard'],
    plugins: ['stylelint-order'],
    rules: {
        /* Phase 1 strictness */
        'import-notation': 'string',
        'alpha-value-notation': 'number',
        'rule-empty-line-before': null,
        'no-duplicate-selectors': true,
        'declaration-block-single-line-max-declarations': null,
        'font-family-name-quotes': 'always-where-required',
        'font-family-no-missing-generic-family-keyword': true,
        'order/order': [
            'custom-properties',
            'dollar-variables',
            'at-rules',
            'declarations',
            'rules'
        ],
        // Allow legacy values for now (will tighten later)
        'color-function-notation': null,
        'property-no-vendor-prefix': null,
        'media-feature-range-notation': null,
        'hue-degree-notation': null,
        'value-keyword-case': null,
        'color-hex-length': null,
        'shorthand-property-no-redundant-values': null,
        'declaration-block-no-redundant-longhand-properties': null,
        'at-rule-empty-line-before': null,
        'no-descending-specificity': null,
        'order/properties-order': null,
        'declaration-empty-line-before': null,
        'selector-class-pattern': null
    },
    ignoreFiles: ['build/**', 'dist/**']
};
