module.exports = {
    plugins: ['babel-plugin-transform-dynamic-import'],
    ignore: ['./src/boilerplate/**/*', './src/public/**/*', './src/public/*', './src/lib/vendor/pptx-in-html-out/**/*', './src/lib/vendor/xlsx/**/*'],
    presets: [
      [
        '@babel/env',
        {
          targets: {
            node: '18',
          },
          corejs: 2,
          useBuiltIns: 'usage',
        },
      ],
    ],
  };